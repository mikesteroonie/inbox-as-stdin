/**
 * Worktree creation, including the case a real run hit: a repository with no
 * commits at all. `git worktree add … HEAD` fails with "invalid reference:
 * HEAD" there, because an unborn HEAD is not a reference yet.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureWorktree, patchFor, statusFor } from '../src/harness/worktree.js'

const emptyRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'wt-empty-'))
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo })
  return repo
}

const repoWithCommit = (): string => {
  const repo = emptyRepo()
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'first'], {
    cwd: repo,
  })
  return repo
}

const root = (): string => mkdtempSync(join(tmpdir(), 'wt-root-'))

describe('ensureWorktree', () => {
  it('cuts a worktree from a repo with history', async () => {
    const wt = await ensureWorktree({ repo: repoWithCommit(), taskId: 'aaaaaaaa', root: root() })
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true)
    expect(wt.branch).toBe('harness/aaaaaaaa')
  })

  it('cuts an orphan worktree from a repo with no commits', async () => {
    const wt = await ensureWorktree({ repo: emptyRepo(), taskId: 'bbbbbbbb', root: root() })
    expect(existsSync(wt.path)).toBe(true)

    // And it has to be usable, not merely created.
    writeFileSync(join(wt.path, 'README.md'), '# hello\n')
    const status = await statusFor(wt)
    expect(status.changedFiles).toContain('README.md')
    const patch = await patchFor(wt)
    expect(patch).toContain('README.md')
    expect(patch).toContain('+# hello')
  })

  it('reattaches to an existing worktree rather than re-cutting it', async () => {
    const repo = repoWithCommit()
    const r = root()
    const first = await ensureWorktree({ repo, taskId: 'cccccccc', root: r })
    writeFileSync(join(first.path, 'scratch.txt'), 'work in progress\n')
    const again = await ensureWorktree({ repo, taskId: 'cccccccc', root: r })
    expect(again.path).toBe(first.path)
    expect(existsSync(join(again.path, 'scratch.txt'))).toBe(true)
  })

  it('refuses a path that is not a git repository, by name', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'))
    await expect(
      ensureWorktree({ repo: notARepo, taskId: 'dddddddd', root: root() }),
    ).rejects.toThrow(/not a git repository/)
  })
})
