import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { blameRegion, dedupeAuthors, headSha, parseLogL } from '../src/harness/blame.js'

describe('parseLogL', () => {
  it('parses the tab-separated format', () => {
    const out = parseLogL(
      'da16902702dbc8ac089a8da39214568ebf234272\tBob\tBob@X.dev\t2026-08-20T07:28:12+00:00\n',
    )
    expect(out).toEqual([
      {
        sha: 'da16902702dbc8ac089a8da39214568ebf234272',
        author: 'Bob',
        email: 'bob@x.dev',
        date: '2026-08-20T07:28:12+00:00',
      },
    ])
  })

  it('skips blank and malformed lines rather than throwing', () => {
    expect(parseLogL('\n\nnot a log line\nzzz\tA\ta@x.dev\t2026\n')).toEqual([])
  })

  it('keeps an unparseable email as-is, lowercased', () => {
    expect(parseLogL('abc1234\tA\tnot-an-email\t2026')[0]!.email).toBe('not-an-email')
  })
})

describe('dedupeAuthors', () => {
  it('keeps the most recent commit per author, in order', () => {
    const entries = [
      { sha: 'a', author: 'Bob', email: 'b@x.dev', date: '3' },
      { sha: 'b', author: 'Ada', email: 'a@x.dev', date: '2' },
      { sha: 'c', author: 'Bob', email: 'b@x.dev', date: '1' },
    ]
    expect(dedupeAuthors(entries).map((e) => e.sha)).toEqual(['a', 'b'])
  })
})

describe('blameRegion against a real repo', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'harness-blame-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    }
    git('init', '-q', '.')
    git('config', 'user.email', 'ada@yourco.dev')
    git('config', 'user.name', 'Ada Lovelace')
    writeFileSync(join(repo, 'retry.ts'), 'one\ntwo\nthree\nfour\nfive\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    git('config', 'user.email', 'bob@yourco.dev')
    git('config', 'user.name', 'Bob Barker')
    writeFileSync(join(repo, 'retry.ts'), 'one\ntwo\nTHREE\nfour\nfive\n')
    git('commit', '-qam', 'second')
  })

  it('returns the region authors, most recent first', async () => {
    const result = await blameRegion({ cwd: repo, file: 'retry.ts', lineStart: 3, lineEnd: 4 })
    expect(result.authors.map((a) => a.email)).toEqual(['bob@yourco.dev', 'ada@yourco.dev'])
    expect(result.authors[0]!.author).toBe('Bob Barker')
  })

  it('gives the fallback chain the bounce retry needs (§6.3)', async () => {
    const result = await blameRegion({ cwd: repo, file: 'retry.ts', lineStart: 3, lineEnd: 3 })
    const next = result.authors.find((a) => a.email !== 'bob@yourco.dev')
    expect(next?.email).toBe('ada@yourco.dev')
  })

  it('normalizes a reversed or zero range', async () => {
    const result = await blameRegion({ cwd: repo, file: 'retry.ts', lineStart: 4, lineEnd: 2 })
    expect(result.lineStart).toBe(4)
    expect(result.lineEnd).toBe(4)
  })

  it('falls back to file history when the range has none', async () => {
    const result = await blameRegion({ cwd: repo, file: 'retry.ts', lineStart: 900, lineEnd: 950 })
    expect(result.authors.length).toBeGreaterThan(0)
  })

  it('returns no authors for an unknown file instead of throwing', async () => {
    expect((await blameRegion({ cwd: repo, file: 'nope.ts', lineStart: 1, lineEnd: 1 })).authors).toEqual([])
  })

  it('reads the head sha, and reports unknown outside a repo', async () => {
    expect(await headSha(repo)).toMatch(/^[0-9a-f]{40}$/)
    expect(await headSha(mkdtempSync(join(tmpdir(), 'not-a-repo-')))).toBe('unknown')
  })
})
