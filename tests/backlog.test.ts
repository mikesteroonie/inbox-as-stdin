/**
 * §10 milestone 1: a message that arrives during an outage is still processed,
 * because every (re)connect replays the backlog from the cursor high-water
 * mark; and `--once` runs that same routine and exits.
 */

import { describe, expect, it } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { BACKEND, REQUESTER, harness, scripted } from './helpers.js'

const deliver = (h: ReturnType<typeof harness>, text: string, at = Date.now()) =>
  h.transport.deliver({ inboxId: BACKEND, from: REQUESTER, text, subject: text, timestamp: at })

describe('backlog recovery (§11)', () => {
  it('--once processes the whole backlog and exits', async () => {
    const h = harness()
    h.runner = scripted([{ text: 'done' }])
    deliver(h, 'first task')
    deliver(h, 'second task')

    const results = await new Daemon({ ...h }).runOnce()
    expect(results.filter((r) => r.disposition === 'task-input').length).toBe(2)
    expect(h.store.listTasks().length).toBe(2)
  })

  it('processes a message that landed while the socket was down', async () => {
    const h = harness()
    h.runner = scripted([{ text: 'done' }])
    const daemon = new Daemon({ ...h })

    // Online: handled through the live subscription.
    deliver(h, 'before the outage')
    await daemon.runOnce()
    expect(h.store.listTasks().length).toBe(1)

    // Outage: the message lands but no event is delivered.
    h.transport.goOffline()
    deliver(h, 'during the outage')
    expect(h.store.listTasks().length).toBe(1)

    // Reconnect: the backlog poll picks it up.
    h.transport.goOnline()
    const results = await daemon.runOnce()
    expect(results.some((r) => r.disposition === 'task-input')).toBe(true)
    expect(h.store.listTasks().length).toBe(2)
  })

  it('is idempotent: a replayed backlog produces no second reply', async () => {
    const h = harness()
    h.runner = scripted([{ text: 'done' }])
    const daemon = new Daemon({ ...h })
    deliver(h, 'only task')

    await daemon.runOnce()
    const replies = h.transport.sent.filter((s) => s.kind === 'reply').length
    const again = await daemon.runOnce()

    expect(again.every((r) => r.disposition === 'duplicate')).toBe(true)
    expect(h.transport.sent.filter((s) => s.kind === 'reply').length).toBe(replies)
  })

  it('advances the per-inbox cursor as it goes', async () => {
    const h = harness()
    h.runner = scripted([{ text: 'done' }])
    const at = Date.now()
    deliver(h, 'task', at)
    await new Daemon({ ...h }).runOnce()
    expect(h.store.getCursor(BACKEND)).toBe(at)
  })

  it('keeps two messages on one thread in order', async () => {
    const h = harness()
    const order: string[] = []
    h.runner = ({ prompt }) => {
      // The prompt renders the whole thread, so identify the message being
      // acted on by its subject line rather than by any mention of it.
      order.push(/\*\*Subject:\*\* second/.test(prompt) ? 'second' : 'first')
      return scripted([{ text: 'done' }])({
        prompt,
        options: {},
        ports: {
          askCodeAuthor: async () => ({ kind: 'refused', reason: '' }),
          sendEmailToAgent: async () => ({ kind: 'refused', reason: '' }),
        },
      })
    }
    const first = deliver(h, 'first message', Date.now())
    h.transport.deliver({
      inboxId: BACKEND,
      from: REQUESTER,
      text: 'second message',
      subject: 'second message',
      threadId: first.threadId,
      timestamp: Date.now() + 1,
    })

    await new Daemon({ ...h }).runOnce()
    expect(order).toEqual(['first', 'second'])
    // Both landed on the same task, because they are the same thread.
    expect(h.store.listTasks().length).toBe(1)
  })
})
