/**
 * `git log -L` → who last touched a line region (§1).
 *
 * The primary author is whoever most recently changed the region. The rest of
 * the list is the region fallback: §6.3 requires that a bounced outreach retry
 * once with "the next-most-recent author of the same line region", so this
 * returns the whole ordered chain, deduped by email, not just the top hit.
 */

import { git } from './worktree.js'
import { normalizeAddress } from '../policy.js'

export interface BlameEntry {
  author: string
  email: string
  sha: string
  /** ISO-8601 author date. */
  date: string
}

export interface BlameResult {
  file: string
  lineStart: number
  lineEnd: number
  /** Distinct authors of the region, most recent first. Empty if unknown. */
  authors: BlameEntry[]
}

const FORMAT = '%H%x09%an%x09%ae%x09%aI'

/** Parse the `--format` output of `git log -L`. Tolerates blank/short lines. */
export function parseLogL(stdout: string): BlameEntry[] {
  const out: BlameEntry[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 4) continue
    const [sha, author, email, date] = parts as [string, string, string, string]
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue
    out.push({ sha, author, email: normalizeAddress(email) ?? email.toLowerCase(), date })
  }
  return out
}

/** Drop repeat authors, keeping the most recent commit for each. */
export function dedupeAuthors(entries: readonly BlameEntry[]): BlameEntry[] {
  const seen = new Set<string>()
  const out: BlameEntry[] = []
  for (const e of entries) {
    if (seen.has(e.email)) continue
    seen.add(e.email)
    out.push(e)
  }
  return out
}

export interface BlameOptions {
  cwd: string
  file: string
  lineStart: number
  lineEnd: number
  /** How many commits deep to look. More than a handful is noise. */
  limit?: number
}

export async function blameRegion(opts: BlameOptions): Promise<BlameResult> {
  const start = Math.max(1, Math.trunc(opts.lineStart))
  const end = Math.max(start, Math.trunc(opts.lineEnd))
  const limit = opts.limit ?? 10
  const base: BlameResult = { file: opts.file, lineStart: start, lineEnd: end, authors: [] }

  try {
    const { stdout } = await git(opts.cwd, [
      'log',
      `-L${start},${end}:${opts.file}`,
      '--no-patch',
      `--max-count=${limit}`,
      `--format=${FORMAT}`,
    ])
    return { ...base, authors: dedupeAuthors(parseLogL(stdout)) }
  } catch {
    // `-L` fails on a file with no history at that range (new file, moved
    // file, bad range). Fall back to the file's own history — still the right
    // people to ask, just less precise.
    try {
      const { stdout } = await git(opts.cwd, [
        'log',
        `--max-count=${limit}`,
        `--format=${FORMAT}`,
        '--',
        opts.file,
      ])
      return { ...base, authors: dedupeAuthors(parseLogL(stdout)) }
    } catch {
      return base
    }
  }
}

/** The current sha of the checkout, recorded with each cached answer (§8). */
export async function headSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await git(cwd, ['rev-parse', 'HEAD'])
    return stdout.trim()
  } catch {
    return 'unknown'
  }
}
