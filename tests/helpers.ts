/**
 * Shared scaffolding for the pipeline tests: a temp git repo, a config, and a
 * scripted stand-in for the Agent SDK.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { validateConfig, type HarnessConfig } from '../src/config.js'
import type { Deps } from '../src/dispatch.js'
import type { Runner } from '../src/harness/session.js'
import type { HarnessPorts } from '../src/harness/tools.js'
import { Store } from '../src/store.js'
import { MemoryTransport } from '../src/transport/memory.js'

export const REQUESTER = 'owner@example.com'
export const BACKEND = 'backend@memory.test'
export const FRONTEND = 'frontend@memory.test'

export function tempRepo(files: Record<string, string> = { 'retry.ts': 'one\ntwo\nthree\n' }): string {
  const repo = mkdtempSync(join(tmpdir(), 'harness-repo-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 'ada@example.com')
  git('config', 'user.name', 'Ada Lovelace')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body)
  git('add', '-A')
  git('commit', '-qm', 'initial')
  return repo
}

export function config(over: Partial<HarnessConfig> = {}, repo = '.'): HarnessConfig {
  return validateConfig({
    pod: 'test',
    requester: REQUESTER,
    allowlist: { domains: ['example.com'] },
    budgets: { usd: 5, max_hops: 6, questions_per_person_week: 3, max_concurrent: 3 },
    agents: [
      { name: 'backend', inbox: BACKEND, display_name: 'Backend Agent', repo },
      { name: 'frontend', inbox: FRONTEND, display_name: 'Frontend Agent', repo },
    ],
    ...over,
  })
}

export interface Harness extends Deps {
  transport: MemoryTransport
  store: Store
  root: string
}

export function harness(over: Partial<HarnessConfig> = {}, repo?: string): Harness {
  const root = mkdtempSync(join(tmpdir(), 'harness-root-'))
  const cfg = config(over, repo ?? tempRepo())
  const transport = new MemoryTransport()
  const store = new Store(':memory:')
  const transports = new Map(cfg.agents.map((a) => [a.name, transport as never]))
  return { cfg, store, transport, transports, root }
}

/* ------------------------------------------------------- scripted runner */

export interface Turn {
  /** Text the model "says" on this turn. */
  text?: string
  /** A tool call to make before speaking, through the same ports the SDK uses. */
  call?: (ports: HarnessPorts) => Promise<unknown>
  /** Usage to charge for this turn. */
  usage?: { input?: number; output?: number }
  /** Emit a tool_use block, so the parked-session hard stop is exercised. */
  toolUse?: boolean
}

export const MODEL = 'claude-sonnet-5'

/**
 * A Runner that replays a fixed transcript. Every message shape the real SDK
 * emits that the harness reads — assistant text, usage, tool_use, result — is
 * produced here, so the accounting and stop paths are the real ones.
 */
export function scripted(
  turns: Turn[],
  opts: { sessionId?: string; fail?: string; model?: string } = {},
): Runner {
  const sessionId = opts.sessionId ?? 'sess-test'
  const model = opts.model ?? MODEL
  return ({ ports }) => {
    let closed = false
    const iterator = (async function* (): AsyncGenerator<SDKMessage, void> {
      if (opts.fail) throw new Error(opts.fail)
      let total = { input: 0, output: 0 }
      for (const turn of turns) {
        if (closed) return
        if (turn.call) await turn.call(ports)
        if (closed) return
        const usage = { input: turn.usage?.input ?? 0, output: turn.usage?.output ?? 0 }
        total = { input: total.input + usage.input, output: total.output + usage.output }
        yield {
          type: 'assistant',
          uuid: `u-${Math.random().toString(36).slice(2)}` as never,
          session_id: sessionId,
          parent_tool_use_id: null,
          message: {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model,
            stop_reason: null,
            stop_sequence: null,
            content: [
              ...(turn.text ? [{ type: 'text', text: turn.text, citations: null }] : []),
              ...(turn.toolUse
                ? [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'ls' } }]
                : []),
            ],
            usage: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        } as unknown as SDKMessage
      }
      if (closed) return
      yield {
        type: 'result',
        subtype: 'success',
        uuid: 'r-1' as never,
        session_id: sessionId,
        is_error: false,
        num_turns: turns.length,
        duration_ms: 1,
        duration_api_ms: 1,
        result: turns[turns.length - 1]?.text ?? '',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        modelUsage: {
          [model]: {
            inputTokens: total.input,
            outputTokens: total.output,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
        permission_denials: [],
        usage: {},
      } as unknown as SDKMessage
    })()
    return Object.assign(iterator, {
      close: () => {
        closed = true
      },
    })
  }
}

/** One million tokens of output on sonnet is $15 — enough to blow any budget. */
export const EXPENSIVE = { input: 1_000_000, output: 1_000_000 }
