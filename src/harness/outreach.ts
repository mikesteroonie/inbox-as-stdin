/**
 * Outreach (§6.2, §6.3): permission gate, the question email, park and resume.
 *
 * The shape of the flow: a session calls `ask_code_author` → we look for a
 * cached answer → we blame the region → we classify the author against the
 * tiers → tier `ask` mails the requester for permission and parks the session
 * → `yes` sends the question (CC the requester, always) → the author's reply
 * resumes the parked task.
 *
 * Every branch that does not produce an answer resolves the same way: the
 * session is resumed with "author unavailable — make the conservative choice
 * and flag it". A parked task is never left parked.
 */

import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessConfig, ResolvedBudgets } from '../config.js'
import { logger } from '../log.js'
import { checkOutreachBudget, classifyRecipient, normalizeAddress, weekKey } from '../policy.js'
import type { MailTransport } from '../transport/types.js'
import type { QuestionRow, Store, TaskRow } from '../store.js'
import { mintQuestionId } from '../ids.js'
import {
  appendAnswer,
  decisionsPathFor,
  findCached,
  readAnswers,
  syncDecisions,
  type AnswerRecord,
} from './answers.js'
import { blameRegion, headSha, type BlameEntry } from './blame.js'
import { renderPrompt } from './prompts.js'
import type { AskResult } from './tools.js'

const log = logger('outreach')

export interface OutreachDeps {
  cfg: HarnessConfig
  store: Store
  transport: MailTransport
  budgets: ResolvedBudgets
  /** Inbox the agent sends from. */
  inboxId: string
  agentDisplayName: string
  /** Shared answer cache (§8). Comes from the harness root, never from cwd. */
  answersPath: string
}

export interface AskContext {
  task: TaskRow
  threadId: string
  /** Worktree the question is about — blame runs here. */
  worktree: string
  repoName: string
  taskSubject: string
  /** The message to reply to when the requester is asked for permission. */
  requesterMessageId?: string
}

/** What `ask_code_author` hands back to the session. */
export type AskOutcome = AskResult

/**
 * `ask_code_author`. Returns immediately: `cached` when the answer is already
 * on file, `refused` when policy or budget says no (the session continues with
 * the conservative choice), `parked` when a human is being asked.
 */
export async function askCodeAuthor(
  deps: OutreachDeps,
  ctx: AskContext,
  input: { file: string; lineStart: number; lineEnd: number; question: string },
): Promise<AskOutcome> {
  const sha = await headSha(ctx.worktree)

  // §8 — cache first; a repeat question on the same lines sends no email.
  const cached = findCached(await readAnswers(deps.answersPath), {
    file: input.file,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    sha,
  })
  if (cached) {
    log.info('answer served from cache', { file: input.file, stale: cached.stale })
    return { kind: 'cached', answer: cached.record.answer, note: cached.note }
  }

  const blame = await blameRegion({
    cwd: ctx.worktree,
    file: input.file,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
  })
  const author = blame.authors[0]
  if (!author) {
    return { kind: 'refused', reason: `no git history for ${input.file}:${input.lineStart}` }
  }

  const decision = await gate(deps, author.email)
  if (decision.kind === 'refused') return decision

  const questionId = mintQuestionId()
  deps.store.createQuestion({
    question_id: questionId,
    task_id: ctx.task.task_id,
    asked_email: author.email,
    state: decision.tier === 'auto' ? 'sent' : 'pending-permission',
    file: input.file,
    line_start: input.lineStart,
    line_end: input.lineEnd,
    question: input.question,
  })

  if (decision.tier === 'auto') {
    await sendQuestion(deps, ctx, deps.store.getQuestion(questionId)!, author, sha)
  } else {
    await askPermission(deps, ctx, deps.store.getQuestion(questionId)!, author, sha)
  }
  return { kind: 'parked', questionId }
}

type Gate = { kind: 'ok'; tier: 'auto' | 'ask' } | { kind: 'refused'; reason: string }

/** §6.1 tiers, then the §6.3 per-person weekly budget. Over budget acts as skip. */
async function gate(deps: OutreachDeps, email: string): Promise<Gate> {
  const verdict = classifyRecipient({
    recipient: email,
    roster: rosterAddresses(deps.cfg),
    allowlistDomains: deps.cfg.allowlist.domains,
    allowlistEmails: deps.cfg.allowlist.emails,
  })
  if (verdict.tier === 'never') {
    log.warn('outreach denied by policy', { email, reason: verdict.reason })
    return { kind: 'refused', reason: `outreach denied by policy (${verdict.reason})` }
  }
  const used = deps.store.outreachCount(email)
  const budget = checkOutreachBudget(used, deps.budgets.questionsPerPersonWeek)
  if (!budget.ok) {
    log.warn('outreach over weekly budget', { email, used: budget.used, limit: budget.limit })
    return {
      kind: 'refused',
      reason: `${email} has already been asked ${budget.used} question(s) this week (limit ${budget.limit})`,
    }
  }
  return { kind: 'ok', tier: verdict.tier }
}

export function rosterAddresses(cfg: HarnessConfig): string[] {
  return cfg.agents.map((a) => (a.inbox.includes('@') ? a.inbox : `${a.inbox}@agentmail.to`))
}

/* --------------------------------------------------------------- emails */

/** §6.2 — one permission email to the requester per question. */
async function askPermission(
  deps: OutreachDeps,
  ctx: AskContext,
  question: QuestionRow,
  author: BlameEntry,
  sha: string,
): Promise<void> {
  // §6.3 batching: fold every question already pending for this person on this
  // task into one email rather than sending a second gate request.
  const siblings = deps.store
    .listQuestions(ctx.task.task_id, 'pending-permission')
    .filter((q) => q.asked_email === question.asked_email && q.question_id !== question.question_id)
  const questionBlock = [...siblings, question]
    .map((q, i, all) => (all.length > 1 ? `${i + 1}. ${q.question}` : q.question))
    .join('\n')

  const body = renderPrompt('permission', {
    author_name: author.author,
    author_email: author.email,
    task_id: ctx.task.task_id,
    task_subject: ctx.taskSubject,
    file: question.file ?? '',
    line_start: question.line_start ?? 0,
    line_end: question.line_end ?? 0,
    sha: sha.slice(0, 8),
    date: author.date.slice(0, 10),
    question_block: indent(questionBlock),
    used: deps.store.outreachCount(author.email),
    limit: deps.budgets.questionsPerPersonWeek,
  })

  await deps.transport.send(deps.inboxId, {
    to: [deps.cfg.requester],
    subject: `Permission: may I email ${author.author}?`,
    text: body,
    headers: permissionHeaders(question.question_id),
  })
  log.info('permission requested', { question: question.question_id, author: author.email })
}

/** The question itself. CC the requester, always (§6.2). */
export async function sendQuestion(
  deps: OutreachDeps,
  ctx: AskContext,
  question: QuestionRow,
  author: BlameEntry,
  sha: string,
): Promise<void> {
  const footer = renderPrompt('outreach-footer', {
    requester: deps.cfg.requester,
    agent_display_name: deps.agentDisplayName,
  })
  const body = renderPrompt('outreach-question', {
    author_first_name: firstName(author.author),
    agent_display_name: deps.agentDisplayName,
    requester: deps.cfg.requester,
    repo_name: ctx.repoName,
    file: question.file ?? '',
    line_start: question.line_start ?? 0,
    line_end: question.line_end ?? 0,
    sha: sha.slice(0, 8),
    date: author.date.slice(0, 10),
    code_excerpt: await excerpt(ctx.worktree, question),
    question: question.question,
    footer,
  })

  await deps.transport.send(deps.inboxId, {
    to: [author.email],
    cc: [deps.cfg.requester],
    subject: questionSubject(ctx.repoName, question),
    text: body,
    headers: questionHeaders(question.question_id),
  })
  deps.store.updateQuestion(question.question_id, { state: 'sent', asked_email: author.email })
  deps.store.bumpOutreach(author.email, weekKey())
  log.info('question sent', { question: question.question_id, to: author.email })
}

function questionSubject(repoName: string, q: QuestionRow): string {
  const file = q.file ? basename(q.file) : repoName
  return `Quick question about ${file}${q.line_start ? `:${q.line_start}` : ''}`
}

/**
 * Headers that let a reply be routed back without depending on the recipient's
 * mail client preserving anything: the reply is matched on the thread and the
 * sender too (§5.6).
 */
export function questionHeaders(questionId: string): Record<string, string> {
  return { 'x-harness-question': questionId }
}

export function permissionHeaders(questionId: string): Record<string, string> {
  return { 'x-harness-permission': questionId }
}

async function excerpt(worktree: string, q: QuestionRow): Promise<string> {
  if (!q.file || !q.line_start) return ''
  try {
    const text = await readFile(join(worktree, q.file), 'utf8')
    const lines = text.split('\n')
    const from = Math.max(1, q.line_start - 3)
    const to = Math.min(lines.length, (q.line_end ?? q.line_start) + 3)
    const width = String(to).length
    const body = lines
      .slice(from - 1, to)
      .map((l, i) => `${String(from + i).padStart(width)} | ${l}`)
      .join('\n')
    return '```\n' + body + '\n```'
  } catch {
    return ''
  }
}

/* -------------------------------------------------------- verdict paths */

export type Verdict = 'yes' | 'no' | 'skip' | 'unclear'

/**
 * §6.2 verdict parse: first non-quoted line, case-insensitive yes/no/skip.
 * Anything else is `unclear` — the caller re-asks once, then treats it as `no`.
 */
export function parseVerdict(body: string): Verdict {
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('>')) break
    const word = line.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')[0] ?? ''
    if (word === 'yes' || word === 'yep' || word === 'yeah' || word === 'ok' || word === 'sure') return 'yes'
    if (word === 'no' || word === 'nope') return 'no'
    if (word === 'skip') return 'skip'
    return 'unclear'
  }
  return 'unclear'
}

export interface ResumeInstruction {
  kind: 'answer' | 'unavailable'
  question: QuestionRow
  prompt: string
}

/** Record an answer (§8) and build the prompt that resumes the parked session. */
export async function recordAnswer(
  deps: OutreachDeps,
  question: QuestionRow,
  answer: { text: string; from: string; worktree: string; summary?: string },
): Promise<ResumeInstruction> {
  const record: AnswerRecord = {
    file: question.file ?? '',
    line_start: question.line_start ?? 0,
    line_end: question.line_end ?? 0,
    sha: await headSha(answer.worktree),
    asked: question.asked_email,
    answered_by: normalizeAddress(answer.from) ?? answer.from,
    question: question.question,
    answer: answer.text,
    at: Date.now(),
  }
  await appendAnswer(record, deps.answersPath)
  await syncDecisions(deps.answersPath, decisionsPathFor(answer.worktree))
  deps.store.updateQuestion(question.question_id, { state: 'answered', answer: answer.text })
  log.info('answer recorded', { question: question.question_id, from: record.answered_by })

  return {
    kind: 'answer',
    question,
    prompt: renderPrompt('resume-answer', {
      asked_email: question.asked_email,
      answered_by: record.answered_by,
      file: question.file ?? '',
      line_start: question.line_start ?? 0,
      line_end: question.line_end ?? 0,
      question: question.question,
      answer: fence(answer.text),
      summary_block: summaryBlock(answer.summary),
      worktree: answer.worktree,
    }),
  }
}

/** The `no` / `skip` / bounced / over-budget path — one shared resumption. */
export function unavailable(
  question: QuestionRow,
  reason: string,
  ctx: { worktree: string; summary?: string },
): ResumeInstruction {
  return {
    kind: 'unavailable',
    question,
    prompt: renderPrompt('resume-unavailable', {
      reason,
      asked_email: question.asked_email,
      file: question.file ?? '',
      line_start: question.line_start ?? 0,
      line_end: question.line_end ?? 0,
      question: question.question,
      summary_block: summaryBlock(ctx.summary),
      worktree: ctx.worktree,
    }),
  }
}

/**
 * §6.3 bounce: mark bounced, retry once with the next-most-recent author of
 * the same line region, then behave as skip.
 */
export async function handleBounce(
  deps: OutreachDeps,
  ctx: AskContext,
  question: QuestionRow,
): Promise<{ retried: true; to: string } | { retried: false; reason: string }> {
  deps.store.updateQuestion(question.question_id, { state: 'bounced' })
  if (!question.file || !question.line_start) {
    return { retried: false, reason: `mail to ${question.asked_email} bounced` }
  }
  const blame = await blameRegion({
    cwd: ctx.worktree,
    file: question.file,
    lineStart: question.line_start,
    lineEnd: question.line_end ?? question.line_start,
  })
  const next = blame.authors.find((a) => a.email !== question.asked_email)
  if (!next) {
    return { retried: false, reason: `mail to ${question.asked_email} bounced and no other author touched those lines` }
  }
  const decision = await gate(deps, next.email)
  if (decision.kind === 'refused') {
    return { retried: false, reason: `mail to ${question.asked_email} bounced; ${decision.reason}` }
  }
  deps.store.updateQuestion(question.question_id, { state: 'sent', asked_email: next.email })
  await sendQuestion(
    deps,
    ctx,
    deps.store.getQuestion(question.question_id)!,
    next,
    await headSha(ctx.worktree),
  )
  log.info('bounce fallback sent', { question: question.question_id, to: next.email })
  return { retried: true, to: next.email }
}

/* -------------------------------------------------------------- helpers */

function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name
  return first.replace(/[^\p{L}\p{N}'-]/gu, '') || 'there'
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}

function fence(text: string): string {
  return '```untrusted-email-content\n' + text.trim() + '\n```'
}

function summaryBlock(summary: string | undefined): string {
  if (!summary?.trim()) return ''
  return `**Where you left off**\n\n${summary.trim()}`
}
