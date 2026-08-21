/**
 * How the session is permitted to act.
 *
 * These pin down a bug that only a live run found: the session used to ask for
 * `bypassPermissions`, which the CLI refuses outright when the process runs as
 * root — precisely where a daemon lives. The replacement is a `canUseTool`
 * gate, and the subtle failure mode there is that a bare `allowedTools` entry
 * auto-approves a tool *before* the callback is consulted, which would make
 * the gate decorative for exactly the tools that matter.
 */

import { describe, expect, it } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { runSession, resolveTools } from '../src/harness/session.js'
import { TOOL_NAMES } from '../src/harness/tools.js'
import { validateConfig, budgetsFor } from '../src/config.js'
import { scripted } from './helpers.js'

/** Run a session with a capturing runner and hand back the SDK options. */
async function optionsFor(tools?: string[]): Promise<Options> {
  const cfg = validateConfig({
    pod: 'p',
    requester: 'michael@yourco.dev',
    agents: [{ name: 'backend', inbox: 'backend@x.dev', ...(tools ? { tools } : {}) }],
  })
  const agent = cfg.agents[0]!
  let captured: Options | undefined
  const inner = scripted([{ text: 'done' }])
  await runSession({
    taskId: 'abcdefgh',
    agent,
    budgets: budgetsFor(cfg, agent),
    worktree: '/tmp/wt',
    systemPrompt: 'sys',
    prompt: 'do it',
    spentUsd: 0,
    parkedRef: {},
    ports: {
      askCodeAuthor: async () => ({ kind: 'refused', reason: '' }),
      sendEmailToAgent: async () => ({ kind: 'refused', reason: '' }),
    },
    runner: (o) => {
      captured = o.options
      return inner(o)
    },
  })
  return captured!
}

describe('session permissions', () => {
  it('never asks to bypass permissions — the CLI refuses that as root', async () => {
    const options = await optionsFor()
    expect(options.permissionMode).not.toBe('bypassPermissions')
    expect((options as Record<string, unknown>).allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('installs a canUseTool gate', async () => {
    expect(typeof (await optionsFor()).canUseTool).toBe('function')
  })

  it('does not shadow the gate with bare allowedTools entries', async () => {
    const options = await optionsFor(['read', 'write', 'bash'])
    // A bare name here auto-approves before canUseTool runs; the granted tools
    // must not appear, or the gate stops being the enforcement point.
    for (const bare of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']) {
      expect(options.allowedTools ?? []).not.toContain(bare)
    }
  })

  it('allows a granted tool', async () => {
    const options = await optionsFor(['read'])
    const verdict = await options.canUseTool!('Read', { file_path: '/tmp/x' }, {
      signal: new AbortController().signal,
    } as never)
    expect(verdict.behavior).toBe('allow')
  })

  it('denies an ungranted tool, and says what it does have', async () => {
    const options = await optionsFor(['read'])
    const verdict = await options.canUseTool!('Write', { file_path: '/tmp/x' }, {
      signal: new AbortController().signal,
    } as never)
    expect(verdict.behavior).toBe('deny')
    expect((verdict as { message: string }).message).toContain('not granted')
    expect((verdict as { message: string }).message).toContain('Read')
  })

  it('grants both harness tools by default', async () => {
    const options = await optionsFor()
    for (const tool of [TOOL_NAMES.askCodeAuthor, TOOL_NAMES.sendEmailToAgent]) {
      const verdict = await options.canUseTool!(tool, {}, {
        signal: new AbortController().signal,
      } as never)
      expect(verdict.behavior, tool).toBe('allow')
    }
  })

  it('the gate is keyed on exactly what resolveTools grants', async () => {
    const granted = resolveTools(['read'])
    const options = await optionsFor(['read'])
    for (const tool of granted) {
      const verdict = await options.canUseTool!(tool, {}, {
        signal: new AbortController().signal,
      } as never)
      expect(verdict.behavior, tool).toBe('allow')
    }
  })
})
