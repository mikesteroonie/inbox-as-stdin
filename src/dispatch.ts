/**
 * The per-event pipeline (§5). Order is normative:
 *
 *   1. dedupe   2. fetch   3. armor gate   4. envelope parse
 *   5. loop guards   6. route   7. run   8. emit
 *
 * Each step either passes or terminates. This module is the logic; the I/O
 * primitives it uses (transport, store, session runner) arrive as `Deps`, so
 * every branch below is reachable in a test without a network.
 */

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { AgentConfig, HarnessConfig } from './config.js'
import { budgetsFor } from './config.js'
import * as envelope from './envelope.js'
import { mintTaskId } from './ids.js'
import { logger } from './log.js'
import {
  checkHops,
  checkParticipants,
  checkSender,
  classifyRecipient,
  isDeadThread,
  normalizeAddress,
} from './policy.js'
import { extractReply, fenceUntrusted } from './reply.js'
import type { Store, TaskRow } from './store.js'
import { LABEL, type MailEvent, type MailTransport, type Message, type Thread } from './transport/types.js'
import { answersPathFor, decisionsPathFor, readAnswers, syncDecisions } from './harness/answers.js'
import {
  askCodeAuthor,
  handleBounce,
  parseVerdict,
  recordAnswer,
  rosterAddresses,
  sendQuestion,
  unavailable,
  type AskContext,
  type OutreachDeps,
  type ResumeInstruction,
} from './harness/outreach.js'
import { blameRegion, headSha } from './harness/blame.js'
import { renderPrompt } from './harness/prompts.js'
import { runSession, type RunOutcome, type Runner } from './harness/session.js'
import type { AskResult, SendResult } from './harness/tools.js'
import { openPullRequest } from './harness/pr.js'
import { ensureWorktree, patchFor, statusFor, type Worktree } from './harness/worktree.js'

const log = logger('dispatch')

/** AskContext plus the bits only the pipeline needs (§5.7-§5.8). */
interface FullContext extends AskContext {
  worktreeHandle?: Worktree
  agentExtra?: string
}


export interface Deps {
  cfg: HarnessConfig
  store: Store
  /** One transport per agent inbox — each agent holds its own API key (§0). */
  transports: Map<string, MailTransport>
  /** Test seam: replaces the Agent SDK call inside `runSession`. */
  runner?: Runner
  /** Root for worktrees and the journal. */
  root?: string
  now?: () => number
}

export type Disposition =
  | 'duplicate'
  | 'held-by-armor'
  | 'hop-limit'
  | 'participant-limit'
  | 'sender-refused'
  | 'no-agent'
  | 'outreach-resume'
  | 'permission-verdict'
  | 'task-input'
  | 'bounce-handled'
  | 'ignored'
  | 'error'

export interface DispatchResult {
  disposition: Disposition
  taskId?: string
  detail?: string
}

/* ====================================================================== */

export async function dispatch(deps: Deps, event: MailEvent): Promise<DispatchResult> {
  if (event.kind !== 'message.received') return dispatchBounce(deps, event)

  const now = deps.now ?? Date.now

  // 1 — dedupe. Insert first: at-most-once per message is the accepted v1
  // tradeoff (§5.1), and a duplicate webhook must not produce a second reply.
  if (!deps.store.markSeen(event.messageId, now())) {
    log.debug('duplicate message dropped', { messageId: event.messageId })
    return { disposition: 'duplicate' }
  }

  const agent = agentForInbox(deps.cfg, event.inboxId)
  if (!agent) {
    log.warn('event for an inbox with no agent', { inboxId: event.inboxId })
    return { disposition: 'no-agent' }
  }
  const transport = deps.transports.get(agent.name)
  if (!transport) return { disposition: 'no-agent', detail: `no transport for ${agent.name}` }

  // 2 — fetch.
  let message: Message
  try {
    message = await transport.getMessage(event.inboxId, event.messageId)
  } catch (err) {
    log.error('fetch failed', { messageId: event.messageId, err: String(err) })
    return { disposition: 'error', detail: String(err) }
  }

  // Our own outbound mail comes back as an event on the thread; ignore it.
  if (normalizeAddress(message.from) === normalizeAddress(event.inboxId)) {
    return { disposition: 'ignored', detail: 'self-authored' }
  }

  // 3 — armor gate. Never reaches a prompt.
  if (message.armor?.verdict === 'review' || message.armor?.verdict === 'block') {
    await transport.label(event.inboxId, message.threadId, [LABEL.held], [])
    await notify(deps, agent, {
      subject: `Held for review: ${message.subject ?? '(no subject)'}`,
      text:
        `A message from ${message.from} was held before it reached the agent.\n\n` +
        `Verdict: ${message.armor.verdict}${message.armor.reason ? ` (${message.armor.reason})` : ''}\n` +
        `Thread: ${message.threadId}\nMessage: ${message.messageId}\n\n` +
        `Nothing was run. Release it by forwarding the content yourself if it is genuine.`,
    })
    log.warn('message held by armor', { messageId: message.messageId, verdict: message.armor.verdict })
    return { disposition: 'held-by-armor' }
  }

  // 4 — envelope parse.
  const env = envelope.parse(message.headers, message.text)

  // 5 — loop guards.
  const thread = await transport.getThread(event.inboxId, message.threadId)
  const budgets = budgetsFor(deps.cfg, agent)
  const hops = checkHops(env.hops, budgets.maxHops)
  if (!hops.ok) {
    return haltOnHops(deps, agent, message, env, hops.cap)
  }

  // SPEC §4 — participant cap. Checked with the hop cap, before any routing:
  // a thread this wide fans every reply out to everyone on it.
  const participants = checkParticipants(thread.participants.length, budgets.maxParticipants)
  if (!participants.ok) {
    return haltOnParticipants(deps, agent, message, env, participants)
  }

  const sender = checkSender({
    from: message.from,
    requester: deps.cfg.requester,
    roster: rosterAddresses(deps.cfg),
    allowlistDomains: deps.cfg.allowlist.domains,
    activeThreadParticipants: activeThreadParticipants(deps, thread),
  })
  if (!sender.ok) {
    log.warn('sender refused', { from: message.from, thread: message.threadId })
    return { disposition: 'sender-refused', detail: message.from }
  }

  // 6 — route.
  const question = routeToQuestion(deps, message, env)
  if (question) return question(deps, agent, message, thread, env)

  return runTaskInput(deps, agent, message, thread, env)
}

/* ------------------------------------------------------------- routing */

type Route = (
  deps: Deps,
  agent: AgentConfig,
  message: Message,
  thread: Thread,
  env: envelope.Envelope,
) => Promise<DispatchResult>

/**
 * §5.6 — an outreach reply or a permission verdict, if this message is one.
 * Returns the handler rather than a boolean so the order in `dispatch` stays
 * the order in the spec.
 */
function routeToQuestion(deps: Deps, message: Message, env: envelope.Envelope): Route | undefined {
  const from = normalizeAddress(message.from)
  if (from === undefined) return undefined

  // A reply carrying the question id, or from an address with a `sent`
  // question on this thread ⇒ outreach resume.
  if (env.inReplyToQuestion) {
    const q = deps.store.getQuestion(env.inReplyToQuestion)
    if (q && q.state === 'sent') return resumeFromAnswer
  }
  const sentOnThread = deps.store
    .findQuestionsByThread(message.threadId, 'sent')
    .find((q) => q.asked_email === from)
  if (sentOnThread) return resumeFromAnswer
  if (deps.store.findSentQuestionFrom(from)) return resumeFromAnswer

  // A reply from the requester on a thread with a pending permission gate.
  if (from === normalizeAddress(deps.cfg.requester)) {
    const pendingHeader = message.headers['x-harness-permission']
    if (pendingHeader && deps.store.getQuestion(pendingHeader)?.state === 'pending-permission') {
      return permissionVerdict
    }
    const pendingOnThread = deps.store.findQuestionsByThread(message.threadId, 'pending-permission')
    if (pendingOnThread.length > 0) return permissionVerdict
    // The permission email starts its own thread, so also accept the most
    // recent pending gate when the requester simply replies to it.
    const anyPending = deps.store
      .listTasks()
      .flatMap((t) => deps.store.listQuestions(t.task_id, 'pending-permission'))
    if (anyPending.length > 0 && looksLikeVerdict(message)) return permissionVerdict
  }
  return undefined
}

function looksLikeVerdict(message: Message): boolean {
  return parseVerdict(message.extractedText || message.text) !== 'unclear'
}

/* ------------------------------------------------------- §6.2 verdicts */

const permissionVerdict: Route = async (deps, agent, message, _thread, _env) => {
  const questions = pendingQuestionsFor(deps, message)
  const first = questions[0]
  if (!first) return { disposition: 'ignored', detail: 'no pending permission' }

  const task = deps.store.getTask(first.task_id)
  if (!task) return { disposition: 'ignored', detail: 'permission for an unknown task' }

  const verdict = parseVerdict(message.extractedText || message.text)
  const ctx = await contextFor(deps, agent, task, message.threadId)

  if (verdict === 'unclear') {
    // §6.2: anything else ⇒ re-ask once, then treat as `no`.
    const asked = deps.store.claimNotice(first.task_id, `reask:${first.question_id}`)
    if (asked) {
      const transport = deps.transports.get(agent.name)!
      await transport.send(inboxOf(agent), {
        to: [deps.cfg.requester],
        subject: `Permission: may I email ${first.asked_email}?`,
        text:
          `I could not read a verdict in your reply. Reply with a single word on the first ` +
          `line — yes, no, or skip — and I will act on it.\n\nThe question was:\n\n> ${first.question}`,
        headers: { 'x-harness-permission': first.question_id },
      })
      return { disposition: 'permission-verdict', taskId: task.task_id, detail: 'reasked' }
    }
    // Re-asked once already (§6.2) — treat it as `no`, which means recording
    // the questions as skipped exactly as the `no` path does.
    for (const q of questions) deps.store.updateQuestion(q.question_id, { state: 'skipped' })
    return resumeParked(deps, agent, task, ctx, questions, 'permission was not given')
  }

  if (verdict === 'yes') {
    const sha = await headSha(ctx.worktree)
    for (const q of questions) {
      const blame = await blameRegion({
        cwd: ctx.worktree,
        file: q.file ?? '',
        lineStart: q.line_start ?? 1,
        lineEnd: q.line_end ?? 1,
      })
      const author =
        blame.authors.find((a) => a.email === q.asked_email) ??
        ({ author: q.asked_email, email: q.asked_email, sha, date: new Date().toISOString() } as const)
      await sendQuestion(outreachDeps(deps, agent), ctx, q, author, sha)
    }
    return { disposition: 'permission-verdict', taskId: task.task_id, detail: 'sent' }
  }

  // `no` / `skip` ⇒ record and resume with the conservative instruction.
  for (const q of questions) deps.store.updateQuestion(q.question_id, { state: 'skipped' })
  return resumeParked(
    deps,
    agent,
    task,
    ctx,
    questions,
    verdict === 'no' ? 'permission to email them was refused' : 'the requester asked me to skip it',
  )
}

function pendingQuestionsFor(deps: Deps, message: Message) {
  const byHeader = message.headers['x-harness-permission']
  if (byHeader) {
    const q = deps.store.getQuestion(byHeader)
    if (q && q.state === 'pending-permission') {
      return deps.store
        .listQuestions(q.task_id, 'pending-permission')
        .filter((s) => s.asked_email === q.asked_email)
    }
  }
  const onThread = deps.store.findQuestionsByThread(message.threadId, 'pending-permission')
  if (onThread.length > 0) return onThread
  return deps.store
    .listTasks('awaiting-human')
    .flatMap((t) => deps.store.listQuestions(t.task_id, 'pending-permission'))
    .slice(0, 1)
    .flatMap((q) =>
      deps.store.listQuestions(q.task_id, 'pending-permission').filter((s) => s.asked_email === q.asked_email),
    )
}

/* -------------------------------------------------- §6.3 answer resume */

const resumeFromAnswer: Route = async (deps, agent, message, _thread, env) => {
  const from = normalizeAddress(message.from)!
  const question =
    (env.inReplyToQuestion ? deps.store.getQuestion(env.inReplyToQuestion) : undefined) ??
    deps.store.findQuestionsByThread(message.threadId, 'sent').find((q) => q.asked_email === from) ??
    deps.store.findSentQuestionFrom(from)
  if (!question) return { disposition: 'ignored', detail: 'no matching question' }

  const task = deps.store.getTask(question.task_id)
  if (!task) return { disposition: 'ignored', detail: 'answer for an unknown task' }

  const ctx = await contextFor(deps, agent, task, task.thread_id ?? message.threadId)
  const answerText = message.extractedText || extractReply(message.text)

  // An author may decline in place, using the escape hatch in the footer.
  if (parseVerdict(answerText) === 'skip') {
    deps.store.updateQuestion(question.question_id, { state: 'skipped' })
    return resumeParked(deps, agent, task, ctx, [question], `${from} asked not to be involved`)
  }

  const summary = deps.store.getSession(task.thread_id ?? '')?.summary ?? undefined
  const instruction = await recordAnswer(outreachDeps(deps, agent), question, {
    text: answerText,
    from,
    worktree: ctx.worktree,
    ...(summary ? { summary } : {}),
  })
  return continueTask(deps, agent, task, ctx, instruction)
}

async function resumeParked(
  deps: Deps,
  agent: AgentConfig,
  task: TaskRow,
  ctx: FullContext,
  questions: readonly { question_id: string }[],
  reason: string,
): Promise<DispatchResult> {
  const first = questions[0]
  const question = first ? deps.store.getQuestion(first.question_id) : undefined
  if (!question) return { disposition: 'ignored', detail: 'nothing parked' }
  const summary = deps.store.getSession(task.thread_id ?? '')?.summary ?? undefined
  const instruction = unavailable(question, reason, {
    worktree: ctx.worktree,
    ...(summary ? { summary } : {}),
  })
  return continueTask(deps, agent, task, ctx, instruction)
}

/* ------------------------------------------------------- §5.7 task run */

const RESUME_DISPOSITION: Record<ResumeInstruction['kind'], Disposition> = {
  answer: 'outreach-resume',
  unavailable: 'outreach-resume',
}

async function continueTask(
  deps: Deps,
  agent: AgentConfig,
  task: TaskRow,
  ctx: FullContext,
  instruction: ResumeInstruction,
): Promise<DispatchResult> {
  const outcome = await execute(deps, agent, task, ctx, instruction.prompt)
  await emit(deps, agent, task, ctx, outcome)
  return { disposition: RESUME_DISPOSITION[instruction.kind], taskId: task.task_id }
}

async function runTaskInput(
  deps: Deps,
  agent: AgentConfig,
  message: Message,
  thread: Thread,
  env: envelope.Envelope,
): Promise<DispatchResult> {
  const budgets = budgetsFor(deps.cfg, agent)
  const now = (deps.now ?? Date.now)()
  const candidate =
    (env.taskId ? deps.store.getTask(env.taskId) : undefined) ??
    deps.store.getActiveTaskByThread(message.threadId) ??
    deps.store.getLatestTaskByThread(message.threadId)
  // A task past the TTL is abandoned, not dormant: start a fresh one rather
  // than resuming a session whose context is weeks stale (SPEC §4).
  const existing =
    candidate && isDeadThread(candidate.updated_at, budgets.deadThreadTtlDays, now)
      ? undefined
      : candidate

  const task =
    existing ??
    deps.store.createTask({
      task_id: mintTaskId(),
      thread_id: message.threadId,
      agent: agent.name,
      state: 'running',
      hops: env.hops,
    })

  if (existing) {
    // The hop counter ratchets: a message with no envelope (a human replying
    // mid-chain) must not wind it back to zero, or a forced A↔B loop could
    // restart itself by looping through anything that strips headers.
    deps.store.updateTask(task.task_id, {
      state: 'running',
      thread_id: message.threadId,
      hops: Math.max(task.hops, env.hops),
    })
  }

  const ctx = await contextFor(deps, agent, deps.store.getTask(task.task_id)!, message.threadId, {
    subject: message.subject ?? '(no subject)',
    requesterMessageId: message.messageId,
  })

  const prompt = await renderTaskPrompt(deps, agent, deps.store.getTask(task.task_id)!, ctx, message, thread)
  const outcome = await execute(deps, agent, deps.store.getTask(task.task_id)!, ctx, prompt)
  await emit(deps, agent, deps.store.getTask(task.task_id)!, ctx, outcome, message)
  return { disposition: 'task-input', taskId: task.task_id }
}

/** Steps 7 and 8 share this: run the session, book the spend, keep state. */
async function execute(
  deps: Deps,
  agent: AgentConfig,
  task: TaskRow,
  ctx: FullContext,
  prompt: string,
): Promise<RunOutcome> {
  const budgets = budgetsFor(deps.cfg, agent)
  const parkedRef: { questionId?: string } = {}
  const session = deps.store.getSession(task.thread_id ?? '')
  const oDeps = outreachDeps(deps, agent)

  if (task.thread_id) {
    await deps.transports
      .get(agent.name)!
      .label(inboxOf(agent), task.thread_id, [LABEL.running], [LABEL.awaitingHuman, LABEL.replied, LABEL.failed])
      .catch(() => undefined)
  }

  const outcome = await runSession({
    taskId: task.task_id,
    agent,
    budgets,
    worktree: ctx.worktree,
    systemPrompt: systemPromptFor(deps, agent, ctx),
    prompt,
    spentUsd: task.spent_usd,
    ...(session?.session_id ? { resumeSessionId: session.session_id } : {}),
    ...(session?.summary ? { summary: session.summary } : {}),
    ...(deps.runner ? { runner: deps.runner } : {}),
    parkedRef,
    ports: {
      askCodeAuthor: async (input): Promise<AskResult> => {
        const result = await askCodeAuthor(oDeps, ctx, input)
        if (result.kind === 'parked') parkedRef.questionId = result.questionId
        return result
      },
      sendEmailToAgent: (input) => sendToAgent(deps, agent, task, input),
    },
  })

  const delta = Math.max(0, outcome.spentUsd - task.spent_usd)
  if (delta > 0) deps.store.addSpend(task.task_id, delta)
  if (outcome.sessionId && task.thread_id) {
    deps.store.putSession(task.thread_id, { session_id: outcome.sessionId })
  }
  return outcome
}

/* ----------------------------------------------------------- §5.8 emit */

async function emit(
  deps: Deps,
  agent: AgentConfig,
  task: TaskRow,
  ctx: FullContext,
  outcome: RunOutcome,
  inbound?: Message,
): Promise<void> {
  const transport = deps.transports.get(agent.name)!
  const inbox = inboxOf(agent)
  const threadId = task.thread_id ?? ''
  const current = deps.store.getTask(task.task_id) ?? task
  const hops = current.hops + 1

  if (outcome.kind === 'parked') {
    if (threadId) {
      deps.store.putSession(threadId, { summary: outcome.summary })
      await transport.label(inbox, threadId, [LABEL.awaitingHuman], [LABEL.running]).catch(() => undefined)
    }
    deps.store.updateTask(task.task_id, { state: 'awaiting-human' })
    log.info('task parked', { taskId: task.task_id, question: outcome.questionId })
    return
  }

  // Render the ledger before taking the patch so DECISIONS.md ships with the
  // work rather than trailing a commit behind it (§8).
  await syncDecisions(answersPathFor(deps.root), decisionsPathFor(ctx.worktree)).catch(() => undefined)
  const wt = ctx.worktreeHandle
  const patch = wt ? await patchFor(wt) : ''
  const status = wt ? await statusFor(wt) : { changedFiles: [], insertions: 0, deletions: 0 }

  const failed = outcome.kind === 'failed' || outcome.kind === 'over-budget'
  const state = failed ? 'failed' : 'done'

  // SPEC §4.6 — reply with the PR link when there is one. The patch is the
  // contract and ships either way (IMPLEMENTATION §11), so a PR that cannot be
  // opened costs a line of prose, not the deliverable.
  const pr =
    !failed && wt && patch.trim() && deps.cfg.pr !== 'never'
      ? await openPullRequest({
          worktree: wt,
          taskId: task.task_id,
          title: prTitle(ctx, task.task_id),
          body: prBody(outcome, ctx),
        })
      : undefined
  if (pr?.kind === 'opened') log.info('pr link included', { taskId: task.task_id, url: pr.url })

  const header = summaryHeader(outcome, current, status)
  const prLine = pr?.kind === 'opened' ? `\n\n**Pull request:** ${pr.url}` : ''
  const body =
    `${header}${prLine}\n\n${outcome.kind === 'failed' ? outcome.error : outcome.text}`.trim()

  const { headers, text } = envelope.encode(
    { taskId: task.task_id, hops },
    body,
    deps.cfg.envelope,
  )

  const attachments = patch.trim()
    ? [
        {
          filename: `patch-${task.task_id}.diff`,
          contentType: 'text/x-diff',
          content: Buffer.from(patch, 'utf8').toString('base64'),
        },
      ]
    : []

  if (inbound) {
    await transport.reply(inbox, inbound.messageId, {
      text,
      headers,
      cc: [deps.cfg.requester].filter((r) => normalizeAddress(r) !== normalizeAddress(inbound.from)),
      attachments,
    })
  } else {
    await transport.send(inbox, {
      to: [deps.cfg.requester],
      subject: `Re: ${ctx.taskSubject}`,
      text,
      headers,
      attachments,
    })
  }

  deps.store.updateTask(task.task_id, { state, hops })
  if (threadId) {
    deps.store.putSession(threadId, { summary: firstParagraph(outcome.kind === 'failed' ? outcome.error : outcome.text) })
    await transport
      .label(inbox, threadId, [failed ? LABEL.failed : LABEL.replied], [LABEL.running, LABEL.awaitingHuman])
      .catch(() => undefined)
  }
  log.info('replied', { taskId: task.task_id, state, hops, patchBytes: patch.length })
}

function summaryHeader(
  outcome: RunOutcome,
  task: TaskRow,
  status: { changedFiles: string[]; insertions: number; deletions: number },
): string {
  const files = status.changedFiles.length
  const diff = files
    ? `${files} file${files === 1 ? '' : 's'} changed, +${status.insertions}/-${status.deletions}`
    : 'no files changed'
  const spend = `$${task.spent_usd.toFixed(2)}`
  if (outcome.kind === 'over-budget') {
    return `**Stopped: over budget.** Spent ${spend}; ${diff}. The work so far is attached — reply to continue with a raised budget.`
  }
  if (outcome.kind === 'failed') {
    return `**Task failed.** Spent ${spend}; ${diff}.`
  }
  return `**Task ${task.task_id}** — ${diff}, ${spend}.`
}

function prTitle(ctx: FullContext, taskId: string): string {
  const subject = ctx.taskSubject.replace(/^(re|fwd):\s*/i, '').trim()
  return subject && subject !== `task ${taskId}` ? subject.slice(0, 72) : `Task ${taskId}`
}

function prBody(outcome: RunOutcome, ctx: FullContext): string {
  // `emit` only opens a PR on a finished run, but keep this total: a parked
  // outcome carries `summary` rather than `text`.
  const summary =
    outcome.kind === 'failed' ? outcome.error : outcome.kind === 'parked' ? outcome.summary : outcome.text
  return (
    `${summary.trim()}\n\n---\n` +
    `Opened by the email harness for task \`${ctx.task.task_id}\`, from a request on thread ` +
    `\`${ctx.threadId}\`. The requester is on that thread and is the person to ask about intent.\n`
  )
}

function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/)[0]?.slice(0, 2000) ?? ''
}

/* ------------------------------------------------- §5 bounce / rejects */

async function dispatchBounce(
  deps: Deps,
  event: Extract<MailEvent, { kind: 'message.bounced' | 'message.rejected' }>,
): Promise<DispatchResult> {
  const agent = agentForInbox(deps.cfg, event.inboxId)
  if (!agent) return { disposition: 'no-agent' }

  const recipients = event.recipients.map((r) => normalizeAddress(r)).filter((r): r is string => !!r)
  const question = recipients.map((r) => deps.store.findSentQuestionFrom(r)).find((q) => q !== undefined)

  if (question) {
    const task = deps.store.getTask(question.task_id)
    if (task) {
      const ctx = await contextFor(deps, agent, task, task.thread_id ?? '')
      const result = await handleBounce(outreachDeps(deps, agent), ctx, question)
      if (result.retried) {
        return { disposition: 'bounce-handled', taskId: task.task_id, detail: `retried to ${result.to}` }
      }
      await resumeParked(deps, agent, task, ctx, [question], result.reason)
      return { disposition: 'bounce-handled', taskId: task.task_id, detail: result.reason }
    }
  }

  // Not an outreach bounce: the task itself failed to reach someone.
  const task = event.threadId ? deps.store.getActiveTaskByThread(event.threadId) : undefined
  if (task) deps.store.updateTask(task.task_id, { state: 'failed' })
  await notify(deps, agent, {
    subject: `Undeliverable: ${recipients.join(', ') || 'message'}`,
    text:
      `A message the harness sent could not be delivered.\n\n` +
      `Recipients: ${recipients.join(', ') || '(unknown)'}\n` +
      `Reason: ${event.reason ?? event.kind}\n` +
      (task ? `Task ${task.task_id} has been marked failed.\n` : ''),
  })
  return { disposition: 'bounce-handled', ...(task ? { taskId: task.task_id } : {}) }
}

/* --------------------------------------------- SPEC §4 participant cap */

async function haltOnParticipants(
  deps: Deps,
  agent: AgentConfig,
  message: Message,
  env: envelope.Envelope,
  verdict: { count: number; cap: number },
): Promise<DispatchResult> {
  const task =
    (env.taskId ? deps.store.getTask(env.taskId) : undefined) ??
    deps.store.getActiveTaskByThread(message.threadId)
  const key = task?.task_id ?? message.threadId
  if (task) deps.store.updateTask(task.task_id, { state: 'failed' })
  if (deps.store.claimNotice(key, 'participant-limit')) {
    await notify(deps, agent, {
      subject: `Too many people on thread${task ? ` for task ${task.task_id}` : ''}`,
      text:
        `Thread ${message.threadId} now has ${verdict.count} participants, past the cap of ` +
        `${verdict.cap}. Nothing was run.\n\n` +
        `A thread this wide sends every agent reply to everyone on it. Raise ` +
        `budgets.max_participants in harness.yaml if the audience is intentional, or start a ` +
        `narrower thread.`,
    })
  }
  log.warn('participant cap reached', {
    thread: message.threadId,
    participants: verdict.count,
    cap: verdict.cap,
  })
  return { disposition: 'participant-limit', ...(task ? { taskId: task.task_id } : {}) }
}

/* ---------------------------------------------- SPEC §4 dead-thread TTL */

/**
 * Close out tasks nobody has touched inside the TTL. A parked question whose
 * human never answered would otherwise hold a session open forever; this ends
 * it, tells the requester once, and leaves the thread labelled.
 */
export async function expireDeadThreads(deps: Deps, now = (deps.now ?? Date.now)()): Promise<string[]> {
  const expired: string[] = []
  for (const agent of deps.cfg.agents) {
    const budgets = budgetsFor(deps.cfg, agent)
    const transport = deps.transports.get(agent.name)
    if (!transport) continue
    for (const task of deps.store.listStaleTasks(now)) {
      if (task.agent !== agent.name) continue
      if (!isDeadThread(task.updated_at, budgets.deadThreadTtlDays, now)) continue

      const pending = deps.store
        .listQuestions(task.task_id)
        .filter((q) => q.state === 'sent' || q.state === 'pending-permission')
      for (const q of pending) deps.store.updateQuestion(q.question_id, { state: 'skipped' })
      deps.store.updateTask(task.task_id, { state: 'failed' }, now)
      expired.push(task.task_id)

      if (task.thread_id) {
        await transport
          .label(inboxOf(agent), task.thread_id, [LABEL.failed], [LABEL.running, LABEL.awaitingHuman])
          .catch(() => undefined)
      }
      if (deps.store.claimNotice(task.task_id, 'dead-thread', now)) {
        const days = budgets.deadThreadTtlDays
        await notify(deps, agent, {
          subject: `Closing task ${task.task_id} — no activity for ${days} days`,
          text:
            `Task ${task.task_id} has had no activity for ${days} days, so I have closed it.\n\n` +
            (pending.length > 0
              ? `It was waiting on an answer from ${[...new Set(pending.map((q) => q.asked_email))].join(', ')}, ` +
                `which never came.\n\n`
              : '') +
            `Spent $${task.spent_usd.toFixed(2)}. Reply on the thread to start it again.`,
        })
      }
      log.info('dead thread expired', { taskId: task.task_id, days: budgets.deadThreadTtlDays })
    }
  }
  return expired
}

/* ------------------------------------------------------ §5.5 hop limit */

async function haltOnHops(
  deps: Deps,
  agent: AgentConfig,
  message: Message,
  env: envelope.Envelope,
  cap: number,
): Promise<DispatchResult> {
  const task =
    (env.taskId ? deps.store.getTask(env.taskId) : undefined) ??
    deps.store.getActiveTaskByThread(message.threadId)
  const key = task?.task_id ?? message.threadId
  if (task) deps.store.updateTask(task.task_id, { state: 'failed' })
  // Once per task (§5.5).
  if (deps.store.claimNotice(key, 'hop-limit')) {
    await notify(deps, agent, {
      subject: `Hop limit reached${task ? ` on task ${task.task_id}` : ''}`,
      text:
        `A message on thread ${message.threadId} arrived at hop ${env.hops}, which is at or past ` +
        `the cap of ${cap}. Nothing was run and the exchange has been stopped.\n\n` +
        `This is what a loop between two agents looks like from the outside. Raise ` +
        `budgets.max_hops in harness.yaml if the chain is legitimate.`,
    })
  }
  log.warn('hop limit reached', { thread: message.threadId, hops: env.hops, cap })
  return { disposition: 'hop-limit', ...(task ? { taskId: task.task_id } : {}) }
}

/* ------------------------------------------ send_email_to_agent backing */

async function sendToAgent(
  deps: Deps,
  agent: AgentConfig,
  task: TaskRow,
  input: { to: string; subject: string; body: string; threadId?: string },
): Promise<SendResult> {
  const to = normalizeAddress(input.to)
  if (to === undefined) return { kind: 'refused', reason: `"${input.to}" is not an email address` }

  const roster = rosterAddresses(deps.cfg)
  const thread = task.thread_id
    ? await deps.transports
        .get(agent.name)!
        .getThread(inboxOf(agent), task.thread_id)
        .catch(() => undefined)
    : undefined

  const verdict = classifyRecipient({
    recipient: to,
    roster,
    threadParticipants: thread?.participants ?? [],
    allowlistDomains: deps.cfg.allowlist.domains,
  })
  if (verdict.tier !== 'auto') {
    return {
      kind: 'refused',
      reason:
        verdict.tier === 'ask'
          ? `${to} is a person, not an agent in this pod — use ask_code_author to reach a human`
          : `${to} is not in this pod's roster (outreach denied by policy)`,
    }
  }

  const budgets = budgetsFor(deps.cfg, agent)
  const hops = task.hops + 1
  const guard = checkHops(task.hops, budgets.maxHops)
  if (!guard.ok) {
    return { kind: 'refused', reason: `hop limit of ${guard.cap} reached on this task` }
  }

  const { headers, text } = envelope.encode(
    { taskId: task.task_id, hops },
    input.body,
    deps.cfg.envelope,
  )
  const res = await deps.transports.get(agent.name)!.send(inboxOf(agent), {
    to: [to],
    subject: input.subject,
    text,
    headers,
  })
  deps.store.updateTask(task.task_id, { hops })
  log.info('agent-to-agent send', { from: agent.name, to, hops, task: task.task_id })
  return { kind: 'sent', threadId: res.threadId, hops }
}

/* -------------------------------------------------------------- prompts */

function systemPromptFor(deps: Deps, agent: AgentConfig, ctx: FullContext): string {
  return renderPrompt('system', {
    agent_display_name: agent.display_name ?? agent.name,
    worktree: ctx.worktree,
    agent_extra: ctx.agentExtra ?? '',
  })
}

async function renderTaskPrompt(
  deps: Deps,
  agent: AgentConfig,
  task: TaskRow,
  ctx: FullContext,
  message: Message,
  thread: Thread,
): Promise<string> {
  const budgets = budgetsFor(deps.cfg, agent)
  const body = message.extractedText || extractReply(envelope.stripTrailer(message.text))
  const priorMessages = thread.messages.filter((m) => m.messageId !== message.messageId)
  const threadSummary =
    priorMessages.length > 0
      ? `**Earlier on this thread** (${priorMessages.length} message${priorMessages.length === 1 ? '' : 's'}):\n` +
        priorMessages
          .slice(-4)
          .map((m) => `- ${m.from}: ${oneLine(m.extractedText || m.text)}`)
          .join('\n')
      : ''

  const answers = await answersNote(deps)

  return renderPrompt('task', {
    from: message.from,
    to: message.to.join(', '),
    subject: message.subject ?? '(no subject)',
    task_id: task.task_id,
    worktree: ctx.worktree,
    repo: ctx.repoName,
    budget_usd: budgets.usd.toFixed(2),
    budget_remaining: Math.max(0, budgets.usd - task.spent_usd).toFixed(2),
    thread_summary: threadSummary,
    body: fenceUntrusted(body),
    cached_answers: answers,
  })
}

async function answersNote(deps: Deps): Promise<string> {
  const records = await readAnswers(answersPathFor(deps.root))
  if (records.length === 0) return ''
  return (
    `**Answers already on file** (in \`DECISIONS.md\`; ${records.length} total). Check it before ` +
    `asking anyone anything — the answer to your question may already be there.`
  )
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/* -------------------------------------------------------------- helpers */

export function agentForInbox(cfg: HarnessConfig, inboxId: string): AgentConfig | undefined {
  const target = normalizeAddress(inboxId) ?? inboxId.toLowerCase()
  const local = target.split('@')[0]
  return cfg.agents.find((a) => {
    const addr = normalizeAddress(inboxOf(a)) ?? inboxOf(a).toLowerCase()
    return addr === target || a.inbox.toLowerCase() === target || a.inbox.toLowerCase() === local
  })
}

export function inboxOf(agent: AgentConfig): string {
  return agent.inbox.includes('@') ? agent.inbox : `${agent.inbox}@agentmail.to`
}

/** Participants of every thread that currently has a live task (§5.5). */
function activeThreadParticipants(deps: Deps, thread: Thread): string[] {
  const active = deps.store.getActiveTaskByThread(thread.threadId)
  return active ? thread.participants : []
}

async function contextFor(
  deps: Deps,
  agent: AgentConfig,
  task: TaskRow,
  threadId: string,
  extra?: { subject?: string; requesterMessageId?: string },
): Promise<FullContext> {
  // `ensureWorktree` reattaches to an existing checkout, so a resumed task
  // picks up exactly where it left off without a cache to go stale.
  const handle = await ensureWorktree({
    repo: agent.repo,
    taskId: task.task_id,
    ...(deps.root ? { root: deps.root } : {}),
  })
  if (task.worktree !== handle.path) deps.store.updateTask(task.task_id, { worktree: handle.path })
  return {
    task,
    threadId,
    worktree: handle.path,
    worktreeHandle: handle,
    repoName: basename(resolve(handle.repo)),
    taskSubject: extra?.subject ?? `task ${task.task_id}`,
    ...(extra?.requesterMessageId ? { requesterMessageId: extra.requesterMessageId } : {}),
    ...(agent.prompt ? { agentExtra: readAgentPrompt(agent.prompt) } : {}),
  }
}

function readAgentPrompt(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // A missing per-agent prompt file is a config typo, not a reason to
    // refuse the task; the base system prompt still applies.
    log.warn('agent prompt file unreadable', { path })
    return ''
  }
}

function outreachDeps(deps: Deps, agent: AgentConfig): OutreachDeps {
  return {
    cfg: deps.cfg,
    store: deps.store,
    transport: deps.transports.get(agent.name)!,
    budgets: budgetsFor(deps.cfg, agent),
    inboxId: inboxOf(agent),
    agentDisplayName: agent.display_name ?? agent.name,
    answersPath: answersPathFor(deps.root),
  }
}

async function notify(
  deps: Deps,
  agent: AgentConfig,
  msg: { subject: string; text: string },
): Promise<void> {
  try {
    await deps.transports.get(agent.name)!.send(inboxOf(agent), {
      to: [deps.cfg.requester],
      subject: msg.subject,
      text: msg.text,
    })
  } catch (err) {
    log.error('could not notify requester', { err: String(err), subject: msg.subject })
  }
}
