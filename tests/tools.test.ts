/**
 * The two tools' model-facing contract (§7): what the session is told after
 * each outcome, including every refusal.
 */

import { describe, expect, it } from 'vitest'
import { TOOL_NAMES, harnessToolDefinitions, type HarnessPorts } from '../src/harness/tools.js'
import { resolveTools } from '../src/harness/session.js'

const ports = (over: Partial<HarnessPorts> = {}): HarnessPorts => ({
  askCodeAuthor: async () => ({ kind: 'parked', questionId: 'q_aaaaaaaaaa' }),
  sendEmailToAgent: async () => ({ kind: 'sent', threadId: 'thr_1', hops: 2 }),
  ...over,
})

const textOf = (result: { content: unknown[] }): string =>
  (result.content[0] as { text: string }).text

describe('send_email_to_agent', () => {
  it('reports the thread and hop count on success', async () => {
    const { sendEmailToAgent } = harnessToolDefinitions(ports())
    const out = await sendEmailToAgent.handler(
      { to: 'frontend@agentmail.to', subject: 's', body: 'b' },
      {},
    )
    expect(textOf(out as never)).toContain('thread thr_1 (hop 2)')
    expect(out.isError).toBeFalsy()
  })

  it('passes an explicit thread through', async () => {
    let seen: unknown
    const { sendEmailToAgent } = harnessToolDefinitions(
      ports({
        sendEmailToAgent: async (input) => {
          seen = input
          return { kind: 'sent', threadId: 'thr_9', hops: 1 }
        },
      }),
    )
    await sendEmailToAgent.handler({ to: 'a@b.dev', subject: 's', body: 'b', thread_id: 'thr_9' }, {})
    expect(seen).toMatchObject({ threadId: 'thr_9' })
  })

  it('returns a refusal the model cannot route around', async () => {
    const { sendEmailToAgent } = harnessToolDefinitions(
      ports({ sendEmailToAgent: async () => ({ kind: 'refused', reason: 'not in the roster' }) }),
    )
    const out = await sendEmailToAgent.handler({ to: 'x@y.dev', subject: 's', body: 'b' }, {})
    expect(out.isError).toBe(true)
    expect(textOf(out as never)).toContain('Do not try another route')
  })
})

describe('ask_code_author', () => {
  it('tells a parked session to stop and hand off', async () => {
    const { askCodeAuthor } = harnessToolDefinitions(ports())
    const out = await askCodeAuthor.handler(
      { file: 'a.ts', line_start: 1, line_end: 2, question: 'why?' },
      {},
    )
    const text = textOf(out as never)
    expect(text).toContain('parked (q_aaaaaaaaaa)')
    expect(text).toContain('Stop now')
    expect(text).toContain('Do not call any more tools')
  })

  it('serves a cached answer with its staleness note and no email', async () => {
    const { askCodeAuthor } = harnessToolDefinitions(
      ports({
        askCodeAuthor: async () => ({ kind: 'cached', answer: 'because rate limits', note: 'answered at abc123' }),
      }),
    )
    const text = textOf(
      (await askCodeAuthor.handler({ file: 'a.ts', line_start: 1, line_end: 1, question: 'why?' }, {})) as never,
    )
    expect(text).toContain('no email sent (answered at abc123)')
    expect(text).toContain('because rate limits')
    expect(text).toContain('Do not ask again')
  })

  it('turns a refusal into the conservative-choice instruction (§6.2)', async () => {
    const { askCodeAuthor } = harnessToolDefinitions(
      ports({ askCodeAuthor: async () => ({ kind: 'refused', reason: 'outreach denied by policy' }) }),
    )
    const text = textOf(
      (await askCodeAuthor.handler({ file: 'a.ts', line_start: 1, line_end: 1, question: 'why?' }, {})) as never,
    )
    expect(text).toContain('outreach denied by policy')
    expect(text).toContain('make the conservative')
  })

  it('rejects a backwards line range before it reaches policy', async () => {
    let called = false
    const { askCodeAuthor } = harnessToolDefinitions(
      ports({
        askCodeAuthor: async () => {
          called = true
          return { kind: 'parked', questionId: 'q_aaaaaaaaaa' }
        },
      }),
    )
    const out = await askCodeAuthor.handler(
      { file: 'a.ts', line_start: 9, line_end: 2, question: 'why?' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(called).toBe(false)
  })
})

describe('resolveTools', () => {
  it('gives a default set including both harness tools', () => {
    const tools = resolveTools(undefined)
    expect(tools).toContain('Read')
    expect(tools).toContain(TOOL_NAMES.askCodeAuthor)
    expect(tools).toContain(TOOL_NAMES.sendEmailToAgent)
  })

  it('expands the friendly names used in harness.yaml', () => {
    expect(resolveTools(['read', 'write'])).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit'])
    expect(resolveTools(['ask_code_author'])).toEqual([TOOL_NAMES.askCodeAuthor])
  })

  it('passes an unrecognised name through verbatim', () => {
    expect(resolveTools(['NotebookEdit'])).toEqual(['NotebookEdit'])
  })

  it('narrows to exactly what the config lists', () => {
    expect(resolveTools(['read'])).not.toContain('Bash')
  })
})
