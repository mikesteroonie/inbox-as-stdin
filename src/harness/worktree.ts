/**
 * task_id → git worktree under `.harness/wt/<task_id>` (§1).
 *
 * Each task gets an isolated checkout so two tasks never fight over the index,
 * and so the deliverable (§11: a patch attachment, always) is a clean diff of
 * exactly one task's work.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { logger } from '../log.js'

const exec = promisify(execFile)
const log = logger('worktree')

export interface GitResult {
  stdout: string
  stderr: string
}

export async function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<GitResult> {
  const { stdout, stderr } = await exec('git', args, {
    cwd,
    maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return { stdout, stderr }
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const { stdout } = await git(path, ['rev-parse', '--is-inside-work-tree'])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

export interface Worktree {
  taskId: string
  /** Absolute path to the worktree the agent works in. */
  path: string
  /** Absolute path of the repository it was cut from. */
  repo: string
  branch: string
}

export interface WorktreeOptions {
  /** Repo path or git URL. A URL is cloned into `.harness/repos/<name>` first. */
  repo: string
  taskId: string
  root?: string
  /** Base revision to branch from. Defaults to the repo's current HEAD. */
  base?: string
}

/**
 * Create (or reattach to) the worktree for a task. Idempotent: resuming a
 * thread reuses the same checkout, which is what makes a second email on the
 * thread continue the same work rather than start over (§10 milestone 2).
 */
export async function ensureWorktree(opts: WorktreeOptions): Promise<Worktree> {
  const root = resolve(opts.root ?? '.harness')
  const { path: repo, cloned } = await ensureRepo(opts.repo, root)
  const path = join(root, 'wt', opts.taskId)
  const branch = `harness/${opts.taskId}`

  if (existsSync(join(path, '.git'))) {
    return { taskId: opts.taskId, path, repo, branch }
  }

  await mkdir(dirname(path), { recursive: true })
  // A clone we manage is branched from the remote's tip, not from whatever it
  // held when it was first fetched; a repo the operator pointed us at is
  // branched from their HEAD, since that is the state they are looking at.
  const base = opts.base ?? (cloned ? await remoteHead(repo) : await headRef(repo))

  const add = async (): Promise<void> => {
    if (base === undefined) {
      // An empty repository has no commit to branch from, so `HEAD` is not a
      // reference yet and `worktree add … HEAD` fails outright. An orphan
      // worktree is the supported way in: the agent starts from nothing, which
      // is exactly right for "here is an empty repo, build me something".
      try {
        await git(repo, ['worktree', 'add', '--orphan', '-b', branch, path])
      } catch (err) {
        throw new Error(
          `${repo} has no commits, and this git cannot create an orphan worktree ` +
            `(needs 2.42+; got ${await gitVersion(repo)}). Make one commit in the repo — even an ` +
            `empty README — and the task will run. Original error: ${(err as Error).message.split('\n')[0]}`,
        )
      }
      return
    }
    await git(repo, ['worktree', 'add', '-b', branch, path, base])
  }

  try {
    await add()
  } catch (err) {
    // A stale registration from a previous run: prune and retry once.
    log.warn('worktree add failed, pruning and retrying', { taskId: opts.taskId, err: String(err) })
    await git(repo, ['worktree', 'prune'])
    await git(repo, ['branch', '-D', branch]).catch(() => undefined)
    await add()
  }
  log.info('worktree created', { taskId: opts.taskId, path, base: base ?? '(empty repo)' })
  return { taskId: opts.taskId, path, repo, branch }
}

async function gitVersion(repo: string): Promise<string> {
  try {
    return (await git(repo, ['--version'])).stdout.trim()
  } catch {
    return 'unknown'
  }
}

/** The commit to branch from, or undefined when the repository has no commits. */
async function headRef(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(repo, ['rev-parse', '--verify', 'HEAD'])
    return stdout.trim()
  } catch {
    return undefined
  }
}

/**
 * Clone a URL into `.harness/repos/<name>`, or pass a local path through.
 *
 * An existing clone is fetched rather than reused as-is. Without that a clone
 * is frozen at the moment it was first made — push a commit and the agent
 * keeps working from code that no longer exists, silently, forever.
 */
async function ensureRepo(repoSpec: string, root: string): Promise<{ path: string; cloned: boolean }> {
  const looksRemote = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(repoSpec)
  if (!looksRemote) {
    const path = isAbsolute(repoSpec) ? repoSpec : resolve(repoSpec)
    if (!(await isGitRepo(path))) {
      throw new Error(`agent repo is not a git repository: ${path}`)
    }
    return { path, cloned: false }
  }
  const name = repoSpec.replace(/\.git$/, '').split(/[/:]/).pop() || 'repo'
  const dest = join(root, 'repos', name)

  if (existsSync(join(dest, '.git'))) {
    try {
      await git(dest, ['fetch', 'origin', '--prune'])
      log.debug('fetched repo', { repo: repoSpec })
    } catch (err) {
      // Offline, or the remote is gone. The existing clone is still workable,
      // so carry on rather than failing the task — but say so, because the
      // agent is about to read code that may be behind.
      log.warn('could not fetch the repo; working from the existing clone', {
        repo: repoSpec,
        err: String(err).split('\n')[0],
      })
    }
    return { path: dest, cloned: true }
  }

  await mkdir(dirname(dest), { recursive: true })
  log.info('cloning repo', { repo: repoSpec, dest })
  await git(root, ['clone', repoSpec, dest])
  return { path: dest, cloned: true }
}

/**
 * The remote's current tip. Falls back through the usual default-branch names
 * and finally to the local HEAD, so a clone made while the remote was empty
 * still resolves once the remote has commits.
 */
async function remoteHead(repo: string): Promise<string | undefined> {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      const { stdout } = await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])
      const sha = stdout.trim()
      if (sha) return sha
    } catch {
      // Try the next candidate.
    }
  }
  return headRef(repo)
}

/**
 * The task's deliverable: a unified diff of everything done in the worktree,
 * including new files. Empty string when the agent changed nothing.
 */
export async function patchFor(wt: Worktree): Promise<string> {
  // Stage everything so untracked files appear in the diff, then diff the index
  // against HEAD. Staging is local to this worktree and harmless.
  await git(wt.path, ['add', '-A'])
  try {
    const { stdout } = await git(wt.path, ['diff', '--cached', '--binary', 'HEAD'])
    return stdout
  } catch {
    // Unborn HEAD (empty repo): diff against the empty tree.
    const { stdout } = await git(wt.path, ['diff', '--cached', '--binary'])
    return stdout
  }
}

export interface WorktreeStatus {
  changedFiles: string[]
  insertions: number
  deletions: number
}

export async function statusFor(wt: Worktree): Promise<WorktreeStatus> {
  await git(wt.path, ['add', '-A'])
  const { stdout } = await git(wt.path, ['diff', '--cached', '--numstat', 'HEAD']).catch(() =>
    git(wt.path, ['diff', '--cached', '--numstat']),
  )
  const changedFiles: string[] = []
  let insertions = 0
  let deletions = 0
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const [add, del, file] = line.split('\t')
    if (file === undefined) continue
    changedFiles.push(file)
    insertions += Number(add) || 0
    deletions += Number(del) || 0
  }
  return { changedFiles, insertions, deletions }
}

/** Remove a worktree and its branch. Used when a task is abandoned. */
export async function removeWorktree(wt: Worktree): Promise<void> {
  await git(wt.repo, ['worktree', 'remove', '--force', wt.path]).catch(async () => {
    await rm(wt.path, { recursive: true, force: true })
    await git(wt.repo, ['worktree', 'prune'])
  })
  await git(wt.repo, ['branch', '-D', wt.branch]).catch(() => undefined)
}
