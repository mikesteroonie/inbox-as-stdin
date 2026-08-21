import { describe, expect, it } from 'vitest'
import { clientId, isQuestionId, isTaskId, mintQuestionId, mintTaskId, TASK_ID_LENGTH } from '../src/ids.js'

describe('clientId', () => {
  /**
   * AgentMail rejects anything outside this set with a 400 at create time.
   * `harness init` used to mint `harness:<name>`; the colon failed every pod
   * and every inbox, which took the whole command down.
   */
  const ALLOWED = /^[A-Za-z0-9._~-]+$/

  it.each([
    ['friday', 'harness-friday'],
    ['HR Bot', 'harness-hr-bot'],
    ['pepper potts', 'harness-pepper-potts'],
    ['swarm-demo', 'harness-swarm-demo'],
    ['a.b_c~d', 'harness-a.b_c~d'],
  ])('%s → %s', (input, expected) => {
    expect(clientId('harness', input)).toBe(expected)
  })

  it.each([
    'friday',
    'HR Bot',
    'café ☕',
    'name:with:colons',
    'lots   of   spaces',
    '--leading-and-trailing--',
    '...',
    '',
    '   ',
    'emoji 🎉 pod',
    'slash/and\\back',
    'quote"and\'apostrophe',
  ])('produces a valid id for %j', (input) => {
    const id = clientId('harness', input)
    expect(id, `input ${JSON.stringify(input)}`).toMatch(ALLOWED)
  })

  it('never returns a bare prefix for empty-ish input', () => {
    expect(clientId('harness', '')).toBe('harness-default')
    expect(clientId('harness', '  ')).toBe('harness-default')
    expect(clientId('harness', '???')).toBe('harness-default')
  })

  it('is stable, so re-running init reuses rather than duplicates', () => {
    expect(clientId('harness', 'Friday')).toBe(clientId('harness', 'friday'))
  })
})

describe('task and question ids', () => {
  it('mints task ids of the declared shape', () => {
    for (let i = 0; i < 50; i++) {
      const id = mintTaskId()
      expect(id).toHaveLength(TASK_ID_LENGTH)
      expect(isTaskId(id)).toBe(true)
    }
  })

  it('rejects anything that is not a task id', () => {
    for (const bad of ['', 'short', 'UPPERCASE', 'has-dash', 'toolongtobevalid', '01234567']) {
      expect(isTaskId(bad), bad).toBe(false)
    }
  })

  it('mints question ids of the declared shape', () => {
    for (let i = 0; i < 50; i++) expect(isQuestionId(mintQuestionId())).toBe(true)
  })

  it('rejects anything that is not a question id', () => {
    for (const bad of ['', 'q_', 'q_short', 'abcdefghij', 'q_UPPERCASE']) {
      expect(isQuestionId(bad), bad).toBe(false)
    }
  })

  it('mints distinct ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => mintTaskId()))
    expect(ids.size).toBeGreaterThan(490)
  })
})
