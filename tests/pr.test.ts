/**
 * SPEC §4.6 — the PR courtesy. Every failure path must degrade to `skipped`,
 * because IMPLEMENTATION §11 makes the patch the contract: a PR that cannot be
 * opened must never cost the requester their deliverable.
 */

import { describe, expect, it } from 'vitest'
import { openPullRequest, type Run } from '../src/harness/pr.js'
import { tempRepo } from './helpers.js'
import type { Worktree } from '../src/harness/worktree.js'

const worktree = (path: string): Worktree => ({
  taskId: 'abcdefgh',
  path,
  repo: path,
  branch: 'harness/abcdefgh',
})

/** A fake `gh`/`git` that succeeds unless a matcher says otherwise. */
function runner(overrides: Record<string, (args: string[]) => string | never> = {}): {
  run: Run
  calls: string[]
} {
  const calls: string[] = []
  const run: Run = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`)
    const key = `${cmd} ${args[0] ?? ''}`.trim()
    const override = overrides[key] ?? overrides[cmd]
    if (override) return override(args)
    if (cmd === 'git' && args[0] === 'remote') return 'origin\n'
    if (cmd === 'gh' && args[0] === 'pr') return 'https://github.com/acme/repo/pull/7\n'
    return ''
  }
  return { run, calls }
}

const req = (path: string, run: Run) => ({
  worktree: worktree(path),
  taskId: 'abcdefgh',
  title: 'Add rate limiting',
  body: 'summary',
  run,
})

describe('openPullRequest', () => {
  it('opens a PR and returns the url', async () => {
    const repo = tempRepo()
    const { run, calls } = runner()
    // Give the branch a commit to push.
    const result = await openPullRequest(req(repo, run))

    expect(result).toEqual({ kind: 'opened', url: 'https://github.com/acme/repo/pull/7' })
    expect(calls.some((c) => c.startsWith('git push -u origin harness/abcdefgh'))).toBe(true)
    expect(calls.some((c) => c.includes('gh pr create --head harness/abcdefgh'))).toBe(true)
  })

  it('skips when gh is not installed', async () => {
    const repo = tempRepo()
    const { run } = runner({
      gh: () => {
        throw new Error('command not found: gh')
      },
    })
    expect(await openPullRequest(req(repo, run))).toEqual({
      kind: 'skipped',
      reason: 'gh is not on PATH',
    })
  })

  it('skips when gh is not authenticated', async () => {
    const repo = tempRepo()
    const { run } = runner({
      'gh auth': () => {
        throw new Error('not logged in')
      },
    })
    expect(await openPullRequest(req(repo, run))).toEqual({
      kind: 'skipped',
      reason: 'gh is not authenticated',
    })
  })

  it('skips a repo with no remote rather than inventing one', async () => {
    const repo = tempRepo()
    const { run, calls } = runner({ 'git remote': () => '' })
    expect(await openPullRequest(req(repo, run))).toEqual({
      kind: 'skipped',
      reason: 'the repo has no git remote',
    })
    expect(calls.some((c) => c.startsWith('git push'))).toBe(false)
  })

  it('skips, never throws, when the push fails', async () => {
    const repo = tempRepo()
    const { run } = runner({
      'git push': () => {
        throw new Error('permission denied\nfatal: could not read')
      },
    })
    const result = await openPullRequest(req(repo, run))
    expect(result.kind).toBe('skipped')
    expect((result as { reason: string }).reason).toContain('permission denied')
  })

  it('skips when gh returns no url', async () => {
    const repo = tempRepo()
    const { run } = runner({ 'gh pr': () => 'created, somehow, with no link\n' })
    expect(await openPullRequest(req(repo, run))).toEqual({
      kind: 'skipped',
      reason: 'gh did not return a PR url',
    })
  })
})
