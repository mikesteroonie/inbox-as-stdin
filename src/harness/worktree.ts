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
  const repo = await ensureRepo(opts.repo, root)
  const path = join(root, 'wt', opts.taskId)
  const branch = `harness/${opts.taskId}`

  if (existsSync(join(path, '.git'))) {
    return { taskId: opts.taskId, path, repo, branch }
  }

  await mkdir(dirname(path), { recursive: true })
  const base = opts.base ?? (await headRef(repo))
  try {
    await git(repo, ['worktree', 'add', '-b', branch, path, base])
  } catch (err) {
    // A stale registration from a previous run: prune and retry once.
    log.warn('worktree add failed, pruning and retrying', { taskId: opts.taskId, err: String(err) })
    await git(repo, ['worktree', 'prune'])
    await git(repo, ['branch', '-D', branch]).catch(() => undefined)
    await git(repo, ['worktree', 'add', '-b', branch, path, base])
  }
  log.info('worktree created', { taskId: opts.taskId, path, base })
  return { taskId: opts.taskId, path, repo, branch }
}

async function headRef(repo: string): Promise<string> {
  try {
    const { stdout } = await git(repo, ['rev-parse', 'HEAD'])
    return stdout.trim()
  } catch {
    // An empty repository has no HEAD; branch from the unborn ref.
    return 'HEAD'
  }
}

/** Clone a URL once into `.harness/repos/<name>`; pass local paths through. */
async function ensureRepo(repoSpec: string, root: string): Promise<string> {
  const looksRemote = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(repoSpec)
  if (!looksRemote) {
    const path = isAbsolute(repoSpec) ? repoSpec : resolve(repoSpec)
    if (!(await isGitRepo(path))) {
      throw new Error(`agent repo is not a git repository: ${path}`)
    }
    return path
  }
  const name = repoSpec.replace(/\.git$/, '').split(/[/:]/).pop() || 'repo'
  const dest = join(root, 'repos', name)
  if (existsSync(join(dest, '.git'))) return dest
  await mkdir(dirname(dest), { recursive: true })
  log.info('cloning repo', { repo: repoSpec, dest })
  await git(root, ['clone', repoSpec, dest])
  return dest
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
