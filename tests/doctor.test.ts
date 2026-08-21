/**
 * `doctor`'s checklist is the diagnostic, so a failure that renders as
 * `[object Object]` or spills a multi-line body across the other rows costs
 * exactly the information the command exists to give. These are the shapes
 * the AgentMail SDK and a websocket actually throw.
 */

import { describe, expect, it } from 'vitest'
import { describeError } from '../src/cli.js'

describe('describeError', () => {
  it('uses a plain Error message', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('appends an SDK error body, which carries the useful half', () => {
    const err = Object.assign(new Error('Status code: 403'), { body: 'Forbidden: bad key' })
    expect(describeError(err)).toBe('Status code: 403: Forbidden: bad key')
  })

  it('does not say the body twice when the message already quotes it', () => {
    const err = Object.assign(new Error('Status code: 403 Body: "no access"'), { body: 'no access' })
    expect(describeError(err)).toBe('Status code: 403 Body: "no access"')
  })

  it('serialises an object body', () => {
    const err = Object.assign(new Error('bad'), { body: { code: 'invalid_key' } })
    expect(describeError(err)).toBe('bad: {"code":"invalid_key"}')
  })

  it('describes a non-Error rejection instead of [object Object]', () => {
    expect(describeError({ code: 1006, reason: 'abnormal closure' })).toBe(
      'reason=abnormal closure code=1006',
    )
    expect(describeError({ type: 'error', error: { message: 'ECONNREFUSED' } })).toBe(
      'type=error error=ECONNREFUSED',
    )
  })

  it('never returns [object Object], whatever it is handed', () => {
    for (const value of [{}, Object.create(null), new Error(''), null, undefined, 42, false]) {
      expect(describeError(value)).not.toContain('[object Object]')
      expect(describeError(value).length).toBeGreaterThan(0)
    }
  })

  it('falls back to the fields of an unrecognised object', () => {
    expect(describeError({ weird: 'shape' })).toBe('{"weird":"shape"}')
  })

  it('collapses newlines so one failure cannot break the checklist layout', () => {
    expect(describeError(new Error('line one\nline two\n   line three'))).toBe(
      'line one line two line three',
    )
  })

  it('truncates a runaway body', () => {
    const long = describeError(new Error('x'.repeat(500)))
    expect(long.length).toBeLessThanOrEqual(241)
    expect(long.endsWith('…')).toBe(true)
  })

  it('flags a blocked host, the failure most often misread as a bad key', () => {
    const err = new Error('Host not in allowlist: api.agentmail.to')
    expect(describeError(err)).toContain('network egress is blocking the host, not the API key')
  })

  it('does not add that hint to an ordinary failure', () => {
    expect(describeError(new Error('invalid api key'))).toBe('invalid api key')
  })
})
