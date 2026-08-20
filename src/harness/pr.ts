/**
 * SPEC §4.6 ends the flagship flow with "→ PR → reply on thread with the
 * link". IMPLEMENTATION.md §11 resolves how: the patch attachment is the
 * contract and always ships; a PR is a courtesy, opened when `gh` is on PATH
 * and authenticated. The harness never manages GitHub credentials itself — it
 * shells out to a CLI the operator already logged into, or does nothing.
 *
 * Every failure here is a `skipped`, never a thrown error: a PR that could not
 * be opened must not cost the requester the patch.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../log.js'
import { git, type Worktree } from './worktree.js'

const exec = promisify(execFile)
const log = logger('pr')

export type PrResult = { kind: 'opened'; url: string } | { kind: 'skipped'; reason: string }

/** Injectable so both branches are testable without a GitHub account. */
export type Run = (cmd: string, args: string[], cwd: string) => Promise<string>

const realRun: Run = async (cmd, args, cwd) => {
  const { stdout } = await exec(cmd, args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
  })
  return stdout
}

export interface PrRequest {
  worktree: Worktree
  title: string
  body: string
  /** Task id, used for the commit message when the agent did not commit. */
  taskId: string
  run?: Run
}

export async function openPullRequest(req: PrRequest): Promise<PrResult> {
  const run = req.run ?? realRun
  const cwd = req.worktree.path

  try {
    await run('gh', ['--version'], cwd)
  } catch {
    return { kind: 'skipped', reason: 'gh is not on PATH' }
  }
  try {
    await run('gh', ['auth', 'status'], cwd)
  } catch {
    return { kind: 'skipped', reason: 'gh is not authenticated' }
  }

  // No remote means nothing to push to — a local-only repo still gets a patch.
  try {
    const remotes = await run('git', ['remote'], cwd)
    if (remotes.trim() === '') return { kind: 'skipped', reason: 'the repo has no git remote' }
  } catch {
    return { kind: 'skipped', reason: 'could not read git remotes' }
  }

  try {
    // The agent may or may not have committed. Commit whatever is left so the
    // branch carries the same content as the patch we are attaching.
    await git(cwd, ['add', '-A'])
    const staged = await git(cwd, ['diff', '--cached', '--name-only'])
    if (staged.stdout.trim() !== '') {
      await git(cwd, ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost', 'commit', '-m', req.title])
    }
    const ahead = await git(cwd, ['rev-list', '--count', '@{upstream}..HEAD']).catch(() => ({
      stdout: '1',
      stderr: '',
    }))
    if (ahead.stdout.trim() === '0') {
      return { kind: 'skipped', reason: 'the branch has no commits to open a PR from' }
    }

    await run('git', ['push', '-u', 'origin', req.worktree.branch], cwd)
    const stdout = await run(
      'gh',
      ['pr', 'create', '--head', req.worktree.branch, '--title', req.title, '--body', req.body],
      cwd,
    )
    const url = stdout.match(/https:\/\/\S+/)?.[0]
    if (!url) return { kind: 'skipped', reason: 'gh did not return a PR url' }
    log.info('pull request opened', { taskId: req.taskId, url })
    return { kind: 'opened', url }
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err)
    log.warn('could not open a pull request', { taskId: req.taskId, reason })
    return { kind: 'skipped', reason }
  }
}
