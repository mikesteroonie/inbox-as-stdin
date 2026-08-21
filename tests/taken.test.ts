/**
 * "That inbox is taken" is the normal path, not an edge case: `agentmail.to`
 * is a shared domain, so obvious names — friday, backend, bot — are usually
 * gone. It must produce a typed error carrying the alternatives, never a crash.
 */

import { describe, expect, it } from 'vitest'
import { asTakenError, suggestedUsernames } from '../src/transport/agentmail.js'
import { InboxTakenError } from '../src/transport/types.js'
import { normalizeAgentNames } from '../src/cli.js'

/** The real body AgentMail returned. */
const REAL_FIX =
  'The requested inbox is already in use. Retry with a different value — these usernames are ' +
  'currently available: friday827, friday_hq, fridayops'

describe('suggestedUsernames', () => {
  it('pulls the alternatives out of the fix sentence', () => {
    expect(suggestedUsernames(REAL_FIX)).toEqual(['friday827', 'friday_hq', 'fridayops'])
  })

  it('handles a trailing sentence after the list', () => {
    expect(suggestedUsernames('… available: alpha, beta. Pick one.')).toEqual(['alpha', 'beta'])
  })

  it('dedupes and drops anything that is not a username', () => {
    expect(suggestedUsernames('available: a, a, , not a name, b')).toEqual(['a', 'b'])
  })

  it('returns nothing when there is no list', () => {
    expect(suggestedUsernames('Something else went wrong')).toEqual([])
    expect(suggestedUsernames('')).toEqual([])
  })
})

describe('asTakenError', () => {
  it('recognises the error by name, with an object body', () => {
    const err = Object.assign(new Error('Status code: 403'), {
      body: { name: 'IsTakenError', code: 'resource_taken', message: 'Inbox is taken', fix: REAL_FIX },
    })
    const taken = asTakenError(err, 'friday')
    expect(taken).toBeInstanceOf(InboxTakenError)
    expect(taken!.username).toBe('friday')
    expect(taken!.suggestions).toEqual(['friday827', 'friday_hq', 'fridayops'])
  })

  it('recognises it when the body arrives as a JSON string', () => {
    const err = Object.assign(new Error('403'), {
      body: JSON.stringify({ code: 'resource_taken', message: 'Inbox is taken', fix: REAL_FIX }),
    })
    expect(asTakenError(err, 'friday')?.suggestions.length).toBe(3)
  })

  it('still types the error when no alternatives were offered', () => {
    const err = Object.assign(new Error('403'), { body: { name: 'IsTakenError', message: 'Inbox is taken' } })
    const taken = asTakenError(err, 'friday')
    expect(taken).toBeInstanceOf(InboxTakenError)
    expect(taken!.suggestions).toEqual([])
  })

  it('leaves unrelated failures alone, so they are not mistaken for a taken name', () => {
    expect(asTakenError(new Error('Host not in allowlist'), 'friday')).toBeUndefined()
    expect(asTakenError(Object.assign(new Error('403'), { body: { code: 'forbidden' } }), 'x')).toBeUndefined()
    expect(asTakenError(null, 'x')).toBeUndefined()
    expect(asTakenError({}, 'x')).toBeUndefined()
  })

  it('carries a readable message either way', () => {
    const withHints = new InboxTakenError('friday', ['friday827'])
    expect(withHints.message).toContain('friday827')
    expect(new InboxTakenError('friday', []).message).toContain('already taken')
  })
})

describe('normalizeAgentNames', () => {
  it('splits, lowercases and dashes what people type', () => {
    expect(normalizeAgentNames('friday, jarvis, pepper')).toEqual(['friday', 'jarvis', 'pepper'])
    expect(normalizeAgentNames('Front End, backend')).toEqual(['front-end', 'backend'])
  })

  it('drops entries that could never be an inbox name', () => {
    expect(normalizeAgentNames('ok, !!!, -bad, 9fine')).toEqual(['ok', '9fine'])
    expect(normalizeAgentNames('')).toEqual([])
    expect(normalizeAgentNames(' , , ')).toEqual([])
  })
})
