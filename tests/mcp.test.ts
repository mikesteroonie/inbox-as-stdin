/**
 * SPEC §6 — the standalone MCP server. The point of it is that a human-driven
 * Claude Code session gets the same policy as the daemon, so these are mostly
 * tests that it cannot mail anyone the daemon would refuse.
 */

import { describe, expect, it } from 'vitest'
import { buildMcpServer, sendToPodAgent } from '../src/mcp.js'
import * as envelope from '../src/envelope.js'
import { BACKEND, FRONTEND, config } from './helpers.js'
import { MemoryTransport } from '../src/transport/memory.js'

const deps = () => {
  const cfg = config()
  return { cfg, agent: cfg.agents[0]!, transport: new MemoryTransport() }
}

describe('sendToPodAgent', () => {
  it('sends to a roster agent by address', async () => {
    const d = deps()
    const result = await sendToPodAgent(d, { to: FRONTEND, subject: 's', body: 'b' })
    expect(result.ok).toBe(true)
    expect(d.transport.sent[0]!.to).toEqual([FRONTEND])
    expect(d.transport.sent[0]!.inboxId).toBe(BACKEND)
  })

  it('resolves an agent by name, so a human need not know the address', async () => {
    const d = deps()
    const result = await sendToPodAgent(d, { to: 'frontend', subject: 's', body: 'b' })
    expect(result.ok).toBe(true)
    expect(d.transport.sent[0]!.to).toEqual([FRONTEND])
  })

  it('stamps the envelope at hop 1 so the daemon hop cap governs the chain', async () => {
    const d = deps()
    await sendToPodAgent(d, { to: 'frontend', subject: 's', body: 'b' })
    const sent = d.transport.sent[0]!
    expect(envelope.parse(sent.headers, sent.text)).toMatchObject({ human: false, hops: 1 })
  })

  it('refuses a person, even on an allowlisted domain', async () => {
    const d = deps()
    const result = await sendToPodAgent(d, { to: 'ada@yourco.dev', subject: 's', body: 'b' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('not an agent')
    expect(d.transport.sent.length).toBe(0)
  })

  it('refuses an address outside the pod entirely', async () => {
    const d = deps()
    expect((await sendToPodAgent(d, { to: 'stranger@example.com', subject: 's', body: 'b' })).ok).toBe(
      false,
    )
    expect(d.transport.sent.length).toBe(0)
  })

  it('rejects a recipient that is not an address at all', async () => {
    const d = deps()
    const result = await sendToPodAgent(d, { to: 'not an address', subject: 's', body: 'b' })
    expect(result.ok).toBe(false)
    expect(d.transport.sent.length).toBe(0)
  })
})

describe('buildMcpServer', () => {
  it('builds without a transport connection', () => {
    expect(buildMcpServer(deps())).toBeDefined()
  })
})
