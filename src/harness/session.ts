/**
 * thread_id → Agent SDK session (§1): create, resume, park, account.
 *
 * Budget is checked before the session starts and after every assistant turn —
 * i.e. after every tool batch (§5.7). Over budget, the query is closed and the
 * task parks as `failed` with the spend and whatever work exists; it never
 * runs on.
 *
 * Resume (§11): primary is the SDK's native resume by stored `session_id`. If
 * that fails, we fall back to a fresh session primed with `sessions.summary`
 * and log the downgrade — a resumed-from-summary session is worth much more
 * than an error emailed to the requester.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConfig, ResolvedBudgets } from '../config.js'
import { logger } from '../log.js'
import { checkBudget } from '../policy.js'
import { costOf, isPriced } from '../pricing.js'
import { createHarnessTools, SERVER_NAME, TOOL_NAMES, type HarnessPorts } from './tools.js'

const log = logger('session')

/** Built-in tools a coding agent gets unless the agent config narrows them. */
const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite']

/** Map the friendly names in harness.yaml onto SDK tool names. */
const TOOL_ALIASES: Record<string, string[]> = {
  read: ['Read', 'Glob', 'Grep'],
  write: ['Write', 'Edit'],
  edit: ['Edit'],
  bash: ['Bash'],
  todo: ['TodoWrite'],
  web: ['WebFetch', 'WebSearch'],
  send_email_to_agent: [TOOL_NAMES.sendEmailToAgent],
  ask_code_author: [TOOL_NAMES.askCodeAuthor],
}

export function resolveTools(names: readonly string[] | undefined): string[] {
  if (names === undefined) return [...DEFAULT_TOOLS, TOOL_NAMES.sendEmailToAgent, TOOL_NAMES.askCodeAuthor]
  const out = new Set<string>()
  for (const raw of names) {
    const key = raw.trim().toLowerCase()
    for (const t of TOOL_ALIASES[key] ?? [raw]) out.add(t)
  }
  return [...out]
}

export interface RunRequest {
  taskId: string
  agent: AgentConfig
  budgets: ResolvedBudgets
  /** Absolute path the session works in. */
  worktree: string
  systemPrompt: string
  prompt: string
  /** Spend already booked against this task, from a previous run on the thread. */
  spentUsd: number
  /** SDK session to resume, if the thread has one. */
  resumeSessionId?: string
  /** One-paragraph handoff, used when native resume is unavailable or fails. */
  summary?: string
  ports: HarnessPorts
  /** Set by the ask_code_author port when it parks the session. */
  parkedRef: { questionId?: string }
  model?: string
  /** Test seam: swap the SDK for a scripted transcript. */
  runner?: Runner
}

export type Runner = (opts: {
  prompt: string
  options: Options
  /** The same ports the MCP tools call, so a scripted transcript can too. */
  ports: HarnessPorts
}) => AsyncIterable<SDKMessage> & { close?: () => void }

export type RunOutcome =
  | { kind: 'completed'; text: string; spentUsd: number; sessionId?: string }
  | { kind: 'parked'; questionId: string; summary: string; spentUsd: number; sessionId?: string }
  | { kind: 'over-budget'; text: string; spentUsd: number; sessionId?: string }
  | { kind: 'failed'; error: string; spentUsd: number; sessionId?: string }

export async function runSession(req: RunRequest): Promise<RunOutcome> {
  const before = checkBudget(req.spentUsd, req.budgets.usd)
  if (!before.ok) {
    return {
      kind: 'over-budget',
      text: `Task budget of $${before.capUsd.toFixed(2)} was already spent before this run started.`,
      spentUsd: before.spentUsd,
    }
  }

  if (req.resumeSessionId) {
    const attempt = await attemptRun(req, req.resumeSessionId)
    if (attempt.kind !== 'resume-failed') return attempt.outcome
    log.warn('native resume failed, downgrading to summary-primed session', {
      taskId: req.taskId,
      sessionId: req.resumeSessionId,
      error: attempt.error,
    })
    const primed: RunRequest = {
      ...req,
      prompt: primeWithSummary(req.prompt, req.summary),
    }
    const fresh = await attemptRun(primed, undefined)
    return fresh.kind === 'resume-failed'
      ? { kind: 'failed', error: fresh.error, spentUsd: req.spentUsd }
      : fresh.outcome
  }

  const attempt = await attemptRun(req, undefined)
  return attempt.kind === 'resume-failed'
    ? { kind: 'failed', error: attempt.error, spentUsd: req.spentUsd }
    : attempt.outcome
}

function primeWithSummary(prompt: string, summary: string | undefined): string {
  if (!summary?.trim()) return prompt
  return (
    `Context from your earlier work on this thread, which you can no longer see directly:\n\n` +
    `${summary.trim()}\n\n---\n\n${prompt}`
  )
}

type Attempt =
  | { kind: 'ran'; outcome: RunOutcome }
  | { kind: 'resume-failed'; error: string }

async function attemptRun(req: RunRequest, resume: string | undefined): Promise<Attempt> {
  const harnessServer = createHarnessTools(req.ports)
  const options: Options = {
    cwd: req.worktree,
    systemPrompt: req.systemPrompt,
    allowedTools: resolveTools(req.agent.tools),
    mcpServers: { [SERVER_NAME]: harnessServer },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // The session works in a throwaway worktree; nothing outside it should
    // leak in, so filesystem settings and project CLAUDE.md files stay off
    // unless the agent's own repo is what we mean to load.
    settingSources: ['project'],
    ...(resume ? { resume } : {}),
    ...(req.model ?? req.agent.model ? { model: (req.model ?? req.agent.model)! } : {}),
  }

  const runner: Runner = req.runner ?? ((o) => query({ prompt: o.prompt, options: o.options }))
  const stream = runner({ prompt: req.prompt, options, ports: req.ports })

  let spent = req.spentUsd
  let sessionId: string | undefined = resume
  let lastText = ''
  let overBudget = false
  let sawAnyMessage = false

  try {
    for await (const message of stream) {
      sawAnyMessage = true
      if ('session_id' in message && typeof message.session_id === 'string') {
        sessionId = message.session_id
      }

      if (message.type === 'assistant') {
        const text = textOf(message)
        if (text) lastText = text
        // Charge the turn, then check: this is the "after every tool batch"
        // point — an assistant message is emitted once per model call.
        const turn = costOfTurn(message)
        if ('unpriced' in turn) {
          stream.close?.()
          return {
            kind: 'ran',
            outcome: {
              kind: 'failed',
              error:
                `Stopped: no price on file for model "${turn.unpriced}", so the $` +
                `${req.budgets.usd.toFixed(2)} budget cannot be enforced. Add it to ` +
                `src/pricing.ts, or pin a priced model for this agent in harness.yaml.`,
              spentUsd: spent,
              ...(sessionId ? { sessionId } : {}),
            },
          }
        }
        spent += turn.cost
        const verdict = checkBudget(spent, req.budgets.usd)
        if (!verdict.ok) {
          overBudget = true
          stream.close?.()
          break
        }
        // A parked session must not keep working. It is told to stop; if it
        // calls another tool anyway, we stop it.
        if (req.parkedRef.questionId && hasToolUse(message)) {
          stream.close?.()
          break
        }
      }

      if (message.type === 'result') {
        // The result carries the authoritative per-model totals; prefer them
        // over our running estimate when they are priceable.
        const total = totalFromResult(message, req.spentUsd)
        if (total !== undefined) spent = total
        if (message.subtype === 'success') {
          lastText = message.result || lastText
        } else if (!req.parkedRef.questionId) {
          return {
            kind: 'ran',
            outcome: {
              kind: 'failed',
              error: `session ended: ${message.subtype}`,
              spentUsd: spent,
              ...(sessionId ? { sessionId } : {}),
            },
          }
        }
        break
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // A resume that the CLI refuses (expired/incompatible session) is
    // recoverable; anything else is a genuine failure.
    if (resume !== undefined && !sawAnyMessage && isResumeError(error)) {
      return { kind: 'resume-failed', error }
    }
    return {
      kind: 'ran',
      outcome: { kind: 'failed', error, spentUsd: spent, ...(sessionId ? { sessionId } : {}) },
    }
  }

  if (overBudget) {
    return {
      kind: 'ran',
      outcome: {
        kind: 'over-budget',
        text: lastText,
        spentUsd: spent,
        ...(sessionId ? { sessionId } : {}),
      },
    }
  }

  if (req.parkedRef.questionId) {
    return {
      kind: 'ran',
      outcome: {
        kind: 'parked',
        questionId: req.parkedRef.questionId,
        summary: lastText,
        spentUsd: spent,
        ...(sessionId ? { sessionId } : {}),
      },
    }
  }

  return {
    kind: 'ran',
    outcome: { kind: 'completed', text: lastText, spentUsd: spent, ...(sessionId ? { sessionId } : {}) },
  }
}

function isResumeError(error: string): boolean {
  return /resume|session .*(not found|expired|invalid)|no such session/i.test(error)
}

function textOf(message: Extract<SDKMessage, { type: 'assistant' }>): string {
  const blocks = message.message.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter((t) => t !== '')
    .join('\n')
    .trim()
}

function hasToolUse(message: Extract<SDKMessage, { type: 'assistant' }>): boolean {
  const blocks = message.message.content
  return Array.isArray(blocks) && blocks.some((b) => b?.type === 'tool_use')
}

/**
 * Cost of one assistant turn from its own usage block (§11: Σ tokens × table).
 *
 * An unpriced model returns `{ unpriced }` rather than 0. Charging $0 for a
 * model we cannot price would silently disable the budget guard — the run would
 * look free and never park — which is the failure §11 exists to prevent.
 */
function costOfTurn(
  message: Extract<SDKMessage, { type: 'assistant' }>,
): { cost: number } | { unpriced: string } {
  const model = message.message.model
  const usage = message.message.usage
  if (!model || !usage) return { cost: 0 }
  if (!isPriced(model)) return { unpriced: model }
  return { cost: costOf(model, {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  }) }
}

/**
 * Total spend from a result message's `modelUsage`, added to what the task had
 * already spent. Returns undefined when any model in the map is unpriced, so
 * the caller keeps its own running estimate rather than under-reporting.
 */
function totalFromResult(
  message: Extract<SDKMessage, { type: 'result' }>,
  priorSpend: number,
): number | undefined {
  const usage = (message as unknown as { modelUsage?: Record<string, Partial<Record<string, number>>> })
    .modelUsage
  if (!usage || Object.keys(usage).length === 0) return undefined
  let run = 0
  for (const [model, counts] of Object.entries(usage)) {
    if (!isPriced(model)) return undefined
    run += costOf(model, {
      inputTokens: counts.inputTokens ?? 0,
      outputTokens: counts.outputTokens ?? 0,
      cacheReadInputTokens: counts.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: counts.cacheCreationInputTokens ?? 0,
    })
  }
  return priorSpend + run
}
