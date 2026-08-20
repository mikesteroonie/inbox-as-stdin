import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendAnswer,
  findCached,
  readAnswers,
  renderDecisions,
  syncDecisions,
  type AnswerRecord,
} from '../src/harness/answers.js'

const record = (over: Partial<AnswerRecord> = {}): AnswerRecord => ({
  file: 'src/retry.ts',
  line_start: 40,
  line_end: 44,
  sha: 'abc12345def',
  asked: 'ada@yourco.dev',
  answered_by: 'ada@yourco.dev',
  question: 'Why is the retry capped at 3?',
  answer: 'Upstream rate-limits at 5/min and we share the budget.',
  at: Date.parse('2026-08-17T09:30:00Z'),
  ...over,
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'harness-answers-'))

describe('jsonl round-trip', () => {
  it('appends and reads back', async () => {
    const dir = tmp()
    const path = join(dir, 'answers.jsonl')
    await appendAnswer(record(), path)
    await appendAnswer(record({ line_start: 90, line_end: 90 }), path)
    expect((await readAnswers(path)).length).toBe(2)
  })

  it('returns nothing for a missing file', async () => {
    expect(await readAnswers(join(tmp(), 'nope.jsonl'))).toEqual([])
  })

  it('loses only the corrupt line, not the cache', async () => {
    const dir = tmp()
    const path = join(dir, 'answers.jsonl')
    writeFileSync(path, `{not json\n${JSON.stringify(record())}\n\n{"file":1}\n`, 'utf8')
    expect((await readAnswers(path)).length).toBe(1)
  })
})

describe('findCached (§8)', () => {
  const records = [record()]

  it('hits on an overlapping range', () => {
    expect(findCached(records, { file: 'src/retry.ts', lineStart: 42, lineEnd: 50 })?.record.answer).toContain(
      'rate-limits',
    )
  })

  it('hits regardless of path style', () => {
    expect(findCached(records, { file: './SRC/Retry.ts', lineStart: 40, lineEnd: 41 })).toBeDefined()
  })

  it('misses a non-overlapping range', () => {
    expect(findCached(records, { file: 'src/retry.ts', lineStart: 80, lineEnd: 90 })).toBeUndefined()
  })

  it('misses another file', () => {
    expect(findCached(records, { file: 'src/other.ts', lineStart: 40, lineEnd: 44 })).toBeUndefined()
  })

  it('flags staleness rather than withholding the answer', () => {
    const hit = findCached(records, { file: 'src/retry.ts', lineStart: 40, lineEnd: 44, sha: 'zzz' })!
    expect(hit.stale).toBe(true)
    expect(hit.note).toContain('has since changed')
  })

  it('is not stale at the same sha', () => {
    const hit = findCached(records, {
      file: 'src/retry.ts',
      lineStart: 40,
      lineEnd: 44,
      sha: 'abc12345def',
    })!
    expect(hit.stale).toBe(false)
  })

  it('prefers the most recent overlapping answer', () => {
    const older = record({ answer: 'old', at: 1 })
    const newer = record({ answer: 'new', at: 2 })
    expect(findCached([older, newer], { file: 'src/retry.ts', lineStart: 41, lineEnd: 41 })!.record.answer).toBe(
      'new',
    )
  })
})

describe('renderDecisions', () => {
  it('says so when empty', () => {
    expect(renderDecisions([])).toContain('No questions have been answered yet')
  })

  it('groups by file with the range, author, date and sha', () => {
    const md = renderDecisions([record(), record({ file: 'src/a.ts', line_start: 1, line_end: 1 })])
    expect(md).toContain('## `src/a.ts`')
    expect(md).toContain('### L40-L44 — ada@yourco.dev (2026-08-17, `abc12345`)')
    expect(md).toContain('### L1 — ada@yourco.dev')
    expect(md).toContain('**Q:** Why is the retry capped at 3?')
  })
})

describe('syncDecisions', () => {
  it('writes on change and is a no-op when unchanged', async () => {
    const dir = tmp()
    const answers = join(dir, 'answers.jsonl')
    const decisions = join(dir, 'DECISIONS.md')
    await appendAnswer(record(), answers)
    expect(await syncDecisions(answers, decisions)).toBe(true)
    expect(readFileSync(decisions, 'utf8')).toContain('Why is the retry capped')
    expect(await syncDecisions(answers, decisions)).toBe(false)
  })
})
