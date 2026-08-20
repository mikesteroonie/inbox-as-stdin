/**
 * Answer cache (§8). `.harness/answers.jsonl`, one record per answered
 * question, plus a `DECISIONS.md` rendered from it — the human-readable
 * ledger the agent commits alongside its work.
 *
 * Before any `ask_code_author` fires, we check for a cached record overlapping
 * the line range. Staleness is flagged, never fatal: an answer given at an
 * older sha is still the author's intent, so it is served with a note rather
 * than withheld.
 */

import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface AnswerRecord {
  file: string
  line_start: number
  line_end: number
  /** Repo sha at the time the question was asked. */
  sha: string
  /** Email of the person asked. */
  asked: string
  /** Email that actually answered (may differ after a bounce fallback). */
  answered_by: string
  question: string
  answer: string
  at: number
}

export interface CacheHit {
  record: AnswerRecord
  /** True when the file has changed since the answer was given (§8). */
  stale: boolean
  /** One line to paste into the prompt, staleness noted. */
  note: string
}

export const ANSWERS_PATH = '.harness/answers.jsonl'
export const DECISIONS_PATH = 'DECISIONS.md'

/** The shared answer cache for a harness root. One per pod, not per task. */
export function answersPathFor(root = '.harness'): string {
  return join(root, 'answers.jsonl')
}

/**
 * The ledger lives *in the worktree* (§8: "committed by the agent along with
 * its work") so it lands in the patch the requester receives.
 */
export function decisionsPathFor(worktree: string): string {
  return join(worktree, DECISIONS_PATH)
}

export async function readAnswers(path = ANSWERS_PATH): Promise<AnswerRecord[]> {
  if (!existsSync(path)) return []
  const text = await readFile(path, 'utf8')
  const out: AnswerRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const rec = JSON.parse(line) as AnswerRecord
      if (typeof rec.file === 'string' && typeof rec.answer === 'string') out.push(rec)
    } catch {
      // A corrupt line loses one answer, not the whole cache.
    }
  }
  return out
}

export async function appendAnswer(record: AnswerRecord, path = ANSWERS_PATH): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end
}

/** Normalize a path for comparison — the cache is keyed by repo-relative path. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Find a cached answer overlapping the requested range, any sha. Most recent
 * wins. Returns undefined when nothing overlaps.
 */
export function findCached(
  records: readonly AnswerRecord[],
  query: { file: string; lineStart: number; lineEnd: number; sha?: string },
): CacheHit | undefined {
  const candidates = records
    .filter((r) => samePath(r.file, query.file))
    .filter((r) =>
      overlaps(
        { start: r.line_start, end: r.line_end },
        { start: query.lineStart, end: query.lineEnd },
      ),
    )
    .sort((a, b) => b.at - a.at)
  const record = candidates[0]
  if (!record) return undefined
  const stale = query.sha !== undefined && record.sha !== 'unknown' && record.sha !== query.sha
  const when = new Date(record.at).toISOString().slice(0, 10)
  const note = stale
    ? `answered by ${record.answered_by} on ${when} at ${record.sha.slice(0, 8)}; the file has since changed`
    : `answered by ${record.answered_by} on ${when} at ${record.sha.slice(0, 8)}`
  return { record, stale, note }
}

/** Render the ledger. `harness up` rewrites this whenever the jsonl changes. */
export function renderDecisions(records: readonly AnswerRecord[]): string {
  const lines: string[] = [
    '# Decisions',
    '',
    'Answers from the people who wrote the code, collected by the harness while it worked.',
    'Generated from `.harness/answers.jsonl` — edit that, not this file.',
    '',
  ]
  if (records.length === 0) {
    lines.push('_No questions have been answered yet._', '')
    return lines.join('\n')
  }
  const byFile = new Map<string, AnswerRecord[]>()
  for (const r of records) {
    const list = byFile.get(r.file) ?? []
    list.push(r)
    byFile.set(r.file, list)
  }
  for (const file of [...byFile.keys()].sort()) {
    lines.push(`## \`${file}\``, '')
    for (const r of byFile.get(file)!.sort((a, b) => a.line_start - b.line_start || a.at - b.at)) {
      const range = r.line_start === r.line_end ? `L${r.line_start}` : `L${r.line_start}-L${r.line_end}`
      const when = new Date(r.at).toISOString().slice(0, 10)
      lines.push(
        `### ${range} — ${r.answered_by} (${when}, \`${r.sha.slice(0, 8)}\`)`,
        '',
        `**Q:** ${r.question.trim()}`,
        '',
        `**A:** ${r.answer.trim()}`,
        '',
      )
    }
  }
  return lines.join('\n')
}

/** Write DECISIONS.md if the rendered content changed. Returns true if written. */
export async function syncDecisions(
  answersPath = ANSWERS_PATH,
  decisionsPath = DECISIONS_PATH,
): Promise<boolean> {
  const rendered = renderDecisions(await readAnswers(answersPath))
  const existing = existsSync(decisionsPath) ? await readFile(decisionsPath, 'utf8') : null
  if (existing === rendered) return false
  await writeFile(decisionsPath, rendered, 'utf8')
  return true
}
