/**
 * The provider→harness mapping. Provider types stop at the transport (§2), so
 * these are the tests that keep the boundary honest.
 */

import { describe, expect, it } from 'vitest'
import { armorOf, toMailEvent, toMessage } from '../src/transport/agentmail.js'
import type { AgentMail } from 'agentmail'

const base = {
  inboxId: 'backend@agentmail.to',
  threadId: 'thr_1',
  messageId: 'msg_1',
  labels: [],
  timestamp: new Date('2026-08-17T09:00:00Z'),
  from: 'Ada <ada@yourco.dev>',
  to: ['backend@agentmail.to'],
  size: 100,
  updatedAt: new Date(),
  createdAt: new Date(),
} as unknown as AgentMail.Message

describe('toMessage', () => {
  it('lowercases header names so §3 parsing is case-insensitive', () => {
    const m = toMessage({ ...base, headers: { 'X-Task-Id': 'abcdefgh' }, text: 'hi' })
    expect(m.headers['x-task-id']).toBe('abcdefgh')
  })

  it('prefers the provider extraction and falls back to ours (§11)', () => {
    const withProvider = toMessage({
      ...base,
      text: 'yes\n> quoted',
      extractedText: 'yes (provider)',
    })
    expect(withProvider.extractedText).toBe('yes (provider)')

    const without = toMessage({ ...base, text: 'yes\n> quoted' })
    expect(without.extractedText).toBe('yes')

    const blankProvider = toMessage({ ...base, text: 'yes\n> quoted', extractedText: '  ' })
    expect(blankProvider.extractedText).toBe('yes')
  })

  it('normalizes optional fields into stable shapes', () => {
    const m = toMessage(base)
    expect(m.cc).toEqual([])
    expect(m.attachments).toEqual([])
    expect(m.text).toBe('')
    expect(m.timestamp).toBe(Date.parse('2026-08-17T09:00:00Z'))
  })

  it('falls back to the preview when there is no text body', () => {
    expect(toMessage({ ...base, preview: 'a preview' }).text).toBe('a preview')
  })

  it('maps attachments without inventing fields', () => {
    const m = toMessage({
      ...base,
      attachments: [{ attachmentId: 'att_1', filename: 'patch.diff', size: 12 }],
    } as unknown as AgentMail.Message)
    expect(m.attachments[0]).toEqual({ attachmentId: 'att_1', filename: 'patch.diff', size: 12 })
  })
})

describe('armorOf (§5.3)', () => {
  it('reads an explicit verdict header', () => {
    expect(armorOf({ 'x-agentmail-armor-verdict': 'Review', 'x-agentmail-armor-reason': 'link' }, [])).toEqual(
      { verdict: 'review', reason: 'link' },
    )
  })

  it('reads an armor label', () => {
    expect(armorOf({}, ['armor/block'])).toEqual({ verdict: 'block', reason: 'armor/block' })
  })

  it('holds provider-flagged mail for review rather than prompting on it', () => {
    expect(armorOf({}, ['spam'])?.verdict).toBe('review')
    expect(armorOf({}, ['unauthenticated'])?.verdict).toBe('review')
    expect(armorOf({}, ['blocked'])?.verdict).toBe('review')
  })

  it('is undefined for ordinary mail, and for a nonsense verdict', () => {
    expect(armorOf({}, ['inbox'])).toBeUndefined()
    expect(armorOf({ 'x-armor-verdict': 'banana' }, [])).toBeUndefined()
    expect(armorOf({}, ['armor/banana'])).toBeUndefined()
  })
})

describe('toMailEvent', () => {
  const message = { inboxId: 'i', messageId: 'm', threadId: 't', timestamp: '2026-08-17T09:00:00Z' }

  it('maps received, including the spam/blocked variants (held later, not dropped)', () => {
    for (const eventType of [
      'message.received',
      'message.received.spam',
      'message.received.blocked',
      'message.received.unauthenticated',
    ]) {
      expect(toMailEvent({ type: 'event', eventType, message })).toMatchObject({
        kind: 'message.received',
        inboxId: 'i',
        messageId: 'm',
        threadId: 't',
      })
    }
  })

  it('maps bounces with their recipients', () => {
    expect(
      toMailEvent({
        type: 'event',
        eventType: 'message.bounced',
        bounce: {
          inboxId: 'i',
          messageId: 'm',
          threadId: 't',
          type: 'Permanent',
          subType: 'NoSuchUser',
          recipients: [{ address: 'ghost@nowhere.dev' }],
        },
      }),
    ).toMatchObject({
      kind: 'message.bounced',
      recipients: ['ghost@nowhere.dev'],
      reason: 'Permanent/NoSuchUser',
    })
  })

  it('maps rejects', () => {
    expect(
      toMailEvent({
        type: 'event',
        eventType: 'message.rejected',
        reject: { inboxId: 'i', messageId: 'm', reason: 'blocked by list' },
      }),
    ).toMatchObject({ kind: 'message.rejected', recipients: [], reason: 'blocked by list' })
  })

  it('ignores frames it does not understand', () => {
    expect(toMailEvent({ type: 'subscribed' })).toBeUndefined()
    expect(toMailEvent({ type: 'event', eventType: 'message.opened' })).toBeUndefined()
    expect(toMailEvent({ type: 'event', eventType: 'message.received' })).toBeUndefined()
    expect(toMailEvent({ type: 'event', eventType: 'message.bounced' })).toBeUndefined()
    expect(toMailEvent({ type: 'event', eventType: 'message.rejected' })).toBeUndefined()
    expect(toMailEvent(null)).toBeUndefined()
  })
})
