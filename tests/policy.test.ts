import { describe, expect, it } from 'vitest'
import {
  checkBudget,
  checkHops,
  checkParticipants,
  isDeadThread,
  checkOutreachBudget,
  checkSender,
  classifyRecipient,
  domainAllowed,
  domainOf,
  normalizeAddress,
  weekKey,
} from '../src/policy.js'

describe('normalizeAddress', () => {
  it.each([
    ['ada@example.com', 'ada@example.com'],
    ['  Ada Lovelace <Ada@example.com> ', 'ada@example.com'],
    ['mailto:ada@example.com', 'ada@example.com'],
    ['"ada@example.com"', 'ada@example.com'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeAddress(raw)).toBe(expected)
  })

  it.each([
    ['not-an-address'],
    ['@example.com'],
    ['ada@'],
    ['ada@localhost'],
    ['ada@.dev'],
    ['ada@dev.'],
    ['two addrs <a@example.org>, <b@example.org>'],
    ['ada lovelace@example.com'],
    ['ada@example.com;bob@example.com'],
    [''],
  ])('rejects %s', (raw) => {
    expect(normalizeAddress(raw)).toBeUndefined()
  })

  it('rejects non-strings', () => {
    expect(normalizeAddress(undefined)).toBeUndefined()
    expect(normalizeAddress(null)).toBeUndefined()
    expect(normalizeAddress(42 as unknown as string)).toBeUndefined()
  })

  it('handles an empty angle-bracket pair', () => {
    expect(normalizeAddress('Ada <>')).toBeUndefined()
  })
})

describe('domainOf', () => {
  it('returns the domain', () => {
    expect(domainOf('Ada <ada@Mail.example.com>')).toBe('mail.example.com')
  })
  it('returns undefined for junk', () => {
    expect(domainOf('nope')).toBeUndefined()
  })
})

describe('domainAllowed', () => {
  it('matches exactly', () => {
    expect(domainAllowed('a@example.com', ['example.com'])).toBe(true)
  })
  it('matches subdomains', () => {
    expect(domainAllowed('a@mail.example.com', ['example.com'])).toBe(true)
  })
  it('does not match a suffix that is not a subdomain', () => {
    // Textually ends in "example.com" but is not a subdomain of it: this is
    // what catches a naive endsWith() check.
    expect(domainAllowed('a@notexample.com', ['example.com'])).toBe(false)
  })
  it('tolerates leading dots and @ in config', () => {
    expect(domainAllowed('a@example.com', ['@example.com'])).toBe(true)
    expect(domainAllowed('a@example.com', ['.example.com'])).toBe(true)
  })
  it('skips blank entries', () => {
    expect(domainAllowed('a@example.com', ['  ', 'example.com'])).toBe(true)
    expect(domainAllowed('a@example.com', ['   '])).toBe(false)
  })
  it('is false for an unparseable address', () => {
    expect(domainAllowed('junk', ['example.com'])).toBe(false)
  })
  it('is false with no allowlist', () => {
    expect(domainAllowed('a@example.com', undefined)).toBe(false)
  })
})

describe('classifyRecipient (§6.1, first match wins)', () => {
  const roster = ['backend@agentmail.to', 'frontend@agentmail.to']
  const allowlistDomains = ['example.com']

  it('1. a thread participant is auto', () => {
    expect(
      classifyRecipient({
        recipient: 'Ada <ADA@example.net>',
        threadParticipants: ['ada@example.net'],
        roster,
        allowlistDomains,
      }),
    ).toEqual({ tier: 'auto', reason: 'thread-participant' })
  })

  it('2. a roster agent is auto', () => {
    expect(classifyRecipient({ recipient: 'backend@agentmail.to', roster, allowlistDomains })).toEqual({
      tier: 'auto',
      reason: 'pod-roster',
    })
  })

  it('3a. an individually allowlisted address is ask', () => {
    expect(
      classifyRecipient({
        recipient: 'Owner <OWNER@Example.COM>',
        roster,
        allowlistEmails: ['owner@example.com'],
      }),
    ).toEqual({ tier: 'ask', reason: 'allowlist-email' })
  })

  it('3a. naming one address does not open their domain', () => {
    expect(
      classifyRecipient({
        recipient: 'someone-else@example.com',
        roster,
        allowlistEmails: ['owner@example.com'],
      }),
    ).toEqual({ tier: 'never', reason: 'default-deny' })
  })

  it('3a. skips unparseable entries in the email allowlist', () => {
    expect(
      classifyRecipient({ recipient: 'a@example.org', allowlistEmails: ['garbage'] }).tier,
    ).toBe('never')
  })

  it('3. an allowlisted domain is ask', () => {
    expect(classifyRecipient({ recipient: 'ada@example.com', roster, allowlistDomains })).toEqual({
      tier: 'ask',
      reason: 'allowlist-domain',
    })
  })

  it('4. everything else is never', () => {
    expect(classifyRecipient({ recipient: 'stranger@example.org', roster, allowlistDomains })).toEqual({
      tier: 'never',
      reason: 'default-deny',
    })
  })

  it('an unparseable recipient is never', () => {
    expect(classifyRecipient({ recipient: 'not an address' })).toEqual({
      tier: 'never',
      reason: 'invalid-address',
    })
  })

  it('is default-deny with no lists at all', () => {
    expect(classifyRecipient({ recipient: 'a@example.org' }).tier).toBe('never')
  })

  it('skips unparseable entries in the participant and roster lists', () => {
    expect(
      classifyRecipient({
        recipient: 'a@example.org',
        threadParticipants: ['garbage'],
        roster: ['also garbage'],
      }).tier,
    ).toBe('never')
  })
})

describe('checkHops (§5.5)', () => {
  it('passes below the cap', () => {
    expect(checkHops(5, 6)).toEqual({ ok: true, hops: 5, cap: 6 })
  })
  it('halts at the cap', () => {
    expect(checkHops(6, 6).ok).toBe(false)
  })
  it('halts above the cap', () => {
    expect(checkHops(9, 6).ok).toBe(false)
  })
  it('normalizes junk to zero', () => {
    expect(checkHops(Number.NaN, 6)).toEqual({ ok: true, hops: 0, cap: 6 })
    expect(checkHops(-3, 6).hops).toBe(0)
    expect(checkHops(2.7, 6).hops).toBe(2)
  })
  it('normalizes a junk cap to zero, which refuses everything', () => {
    expect(checkHops(0, Number.NaN)).toEqual({ ok: false, hops: 0, cap: 0 })
    expect(checkHops(0, -1).cap).toBe(0)
  })
})

describe('checkBudget (§6.4)', () => {
  it('passes under budget', () => {
    expect(checkBudget(1.5, 5)).toEqual({ ok: true, spentUsd: 1.5, capUsd: 5, remainingUsd: 3.5 })
  })
  it('fails at the cap', () => {
    expect(checkBudget(5, 5).ok).toBe(false)
  })
  it('never reports negative remaining', () => {
    expect(checkBudget(9, 5).remainingUsd).toBe(0)
  })
  it('normalizes junk', () => {
    expect(checkBudget(Number.NaN, 5).spentUsd).toBe(0)
    expect(checkBudget(-2, 5).spentUsd).toBe(0)
    expect(checkBudget(0, Number.NaN).capUsd).toBe(0)
    expect(checkBudget(0, -5).capUsd).toBe(0)
  })
})

describe('checkOutreachBudget (§6.3)', () => {
  it('passes under the limit', () => {
    expect(checkOutreachBudget(2, 3)).toEqual({ ok: true, used: 2, limit: 3 })
  })
  it('fails at the limit', () => {
    expect(checkOutreachBudget(3, 3).ok).toBe(false)
  })
  it('normalizes junk', () => {
    expect(checkOutreachBudget(Number.NaN, 3).used).toBe(0)
    expect(checkOutreachBudget(-1, 3).used).toBe(0)
    expect(checkOutreachBudget(1.9, 3).used).toBe(1)
    expect(checkOutreachBudget(0, Number.NaN).limit).toBe(0)
    expect(checkOutreachBudget(0, -1).limit).toBe(0)
  })
})

describe('weekKey', () => {
  it('produces an ISO week key', () => {
    expect(weekKey(new Date('2026-08-20T00:00:00Z'))).toBe('2026-W34')
  })
  it('puts a Sunday in the week that started on Monday', () => {
    expect(weekKey(new Date('2026-01-04T12:00:00Z'))).toBe('2026-W01')
  })
  it('rolls a late-December date into the next ISO year', () => {
    expect(weekKey(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01')
  })
  it('accepts a number and defaults to now', () => {
    expect(weekKey(Date.parse('2026-08-20T00:00:00Z'))).toBe('2026-W34')
    expect(weekKey()).toMatch(/^\d{4}-W\d{2}$/)
  })
})

describe('checkParticipants (SPEC §4)', () => {
  it('passes at or under the cap', () => {
    expect(checkParticipants(10, 10)).toEqual({ ok: true, count: 10, cap: 10 })
    expect(checkParticipants(3, 10).ok).toBe(true)
  })
  it('fails past the cap', () => {
    expect(checkParticipants(11, 10).ok).toBe(false)
  })
  it('normalizes junk', () => {
    expect(checkParticipants(Number.NaN, 10).count).toBe(0)
    expect(checkParticipants(-2, 10).count).toBe(0)
    expect(checkParticipants(2.9, 10).count).toBe(2)
    expect(checkParticipants(0, Number.NaN)).toEqual({ ok: true, count: 0, cap: 0 })
    expect(checkParticipants(0, -1).cap).toBe(0)
  })
})

describe('isDeadThread (SPEC §4)', () => {
  const now = Date.parse('2026-08-20T00:00:00Z')
  const daysAgo = (n: number): number => now - n * 24 * 3600 * 1000

  it('is false inside the TTL', () => {
    expect(isDeadThread(daysAgo(13), 14, now)).toBe(false)
    expect(isDeadThread(now, 14, now)).toBe(false)
  })
  it('is true past the TTL', () => {
    expect(isDeadThread(daysAgo(15), 14, now)).toBe(true)
  })
  it('is exclusive at the boundary', () => {
    expect(isDeadThread(daysAgo(14), 14, now)).toBe(false)
  })
  it('a zero TTL disables expiry rather than expiring everything', () => {
    expect(isDeadThread(daysAgo(999), 0, now)).toBe(false)
  })
  it('normalizes junk', () => {
    expect(isDeadThread(Number.NaN, 14, now)).toBe(false)
    expect(isDeadThread(daysAgo(999), Number.NaN, now)).toBe(false)
    expect(isDeadThread(daysAgo(999), -1, now)).toBe(false)
  })
})

describe('checkSender (§5.5 inbound gate)', () => {
  const base = {
    requester: 'owner@example.com',
    roster: ['backend@agentmail.to'],
    allowlistDomains: ['example.com'],
  }

  it('accepts the requester', () => {
    expect(checkSender({ ...base, from: 'Owner <owner@example.com>' })).toEqual({
      ok: true,
      reason: 'requester',
    })
  })
  it('accepts a roster agent', () => {
    expect(checkSender({ ...base, from: 'backend@agentmail.to' }).reason).toBe('roster')
  })
  it('accepts an allowlisted domain', () => {
    expect(checkSender({ ...base, from: 'ada@example.com' }).reason).toBe('allowlisted')
  })
  it('accepts an individually allowlisted address', () => {
    expect(
      checkSender({ from: 'owner@example.com', allowlistEmails: ['owner@example.com'] }),
    ).toEqual({ ok: true, reason: 'allowlisted-email' })
  })
  it('refuses a colleague of an individually allowlisted address', () => {
    expect(
      checkSender({ from: 'other@example.com', allowlistEmails: ['owner@example.com'] }).ok,
    ).toBe(false)
  })
  it('accepts a participant of an active thread', () => {
    expect(
      checkSender({ ...base, from: 'ada@example.net', activeThreadParticipants: ['ada@example.net'] }),
    ).toEqual({ ok: true, reason: 'thread-participant' })
  })
  it('refuses everyone else', () => {
    expect(checkSender({ ...base, from: 'stranger@example.org' })).toEqual({
      ok: false,
      reason: 'not-allowed',
    })
  })
  it('refuses an unparseable sender', () => {
    expect(checkSender({ ...base, from: 'junk' }).ok).toBe(false)
  })
  it('refuses when nothing is configured', () => {
    expect(checkSender({ from: 'a@example.org' }).ok).toBe(false)
  })
})
