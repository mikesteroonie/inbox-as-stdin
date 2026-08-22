/**
 * SQLite journal (§4). Single file `.harness/journal.db`, no ORM.
 * All writes go through the accessors here, inside transactions.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { weekKey } from './policy.js'

export type TaskState = 'running' | 'awaiting-human' | 'done' | 'failed'
export type QuestionState = 'pending-permission' | 'sent' | 'answered' | 'skipped' | 'bounced'

export interface TaskRow {
  task_id: string
  thread_id: string | null
  agent: string
  state: TaskState
  worktree: string | null
  spent_usd: number
  hops: number
  created_at: number
  updated_at: number
}

export interface SessionRow {
  thread_id: string
  session_id: string | null
  summary: string | null
}

export interface QuestionRow {
  question_id: string
  task_id: string
  asked_email: string
  state: QuestionState
  file: string | null
  line_start: number | null
  line_end: number | null
  question: string
  answer: string | null
  at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen      (message_id TEXT PRIMARY KEY, at INTEGER);
CREATE TABLE IF NOT EXISTS tasks     (task_id TEXT PRIMARY KEY, thread_id TEXT, agent TEXT,
                                      state TEXT,
                                      worktree TEXT, spent_usd REAL DEFAULT 0, hops INTEGER DEFAULT 0,
                                      created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions  (thread_id TEXT PRIMARY KEY, session_id TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS questions (question_id TEXT PRIMARY KEY, task_id TEXT, asked_email TEXT,
                                      state TEXT,
                                      file TEXT, line_start INTEGER, line_end INTEGER, question TEXT,
                                      answer TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS outreach_budget (email TEXT, week TEXT, count INTEGER,
                                      PRIMARY KEY (email, week));
-- §11 backlog recovery: per-inbox high-water mark.
CREATE TABLE IF NOT EXISTS cursors   (inbox_id TEXT PRIMARY KEY, last_event_at INTEGER);
-- One "hop limit reached" notice per task (§5.5).
CREATE TABLE IF NOT EXISTS notices   (task_id TEXT, kind TEXT, at INTEGER, PRIMARY KEY (task_id, kind));

CREATE INDEX IF NOT EXISTS tasks_thread   ON tasks(thread_id);
CREATE INDEX IF NOT EXISTS tasks_state    ON tasks(state);
CREATE INDEX IF NOT EXISTS questions_task ON questions(task_id);
CREATE INDEX IF NOT EXISTS questions_state ON questions(state);
CREATE INDEX IF NOT EXISTS seen_at        ON seen(at);
`

const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export class Store {
  private readonly db: Database.Database

  constructor(path = '.harness/journal.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  /** Run `fn` in a transaction. better-sqlite3 is synchronous, so this nests safely. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /* --------------------------------------------------------------- seen */

  /**
   * §5.1 — returns true the first time a message id is seen, false after.
   * At-most-once per message: the insert happens before the pipeline runs.
   */
  markSeen(messageId: string, at = Date.now()): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO seen (message_id, at) VALUES (?, ?)')
      .run(messageId, at)
    return res.changes > 0
  }

  hasSeen(messageId: string): boolean {
    return this.db.prepare('SELECT 1 FROM seen WHERE message_id = ?').get(messageId) !== undefined
  }

  /** `seen` is pruned at 30 days (§4). */
  pruneSeen(now = Date.now()): number {
    return this.db.prepare('DELETE FROM seen WHERE at < ?').run(now - SEEN_TTL_MS).changes
  }

  /* -------------------------------------------------------------- tasks */

  createTask(row: {
    task_id: string
    thread_id?: string | null
    agent: string
    state?: TaskState
    worktree?: string | null
    hops?: number
    at?: number
  }): TaskRow {
    const at = row.at ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, thread_id, agent, state, worktree, spent_usd, hops, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        row.task_id,
        row.thread_id ?? null,
        row.agent,
        row.state ?? 'running',
        row.worktree ?? null,
        row.hops ?? 0,
        at,
        at,
      )
    return this.getTask(row.task_id)!
  }

  getTask(taskId: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined
  }

  /** The live task on a thread, if any. Newest first; done/failed excluded. */
  getActiveTaskByThread(threadId: string): TaskRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE thread_id = ? AND state IN ('running','awaiting-human')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(threadId) as TaskRow | undefined
  }

  /** Any task on a thread, live or finished — used to resume a settled thread. */
  getLatestTaskByThread(threadId: string): TaskRow | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(threadId) as TaskRow | undefined
  }

  /**
   * Live tasks nobody has touched since `before` — SPEC §4's dead-thread TTL.
   * Only running/awaiting-human tasks can go stale; finished ones are done.
   */
  listStaleTasks(before: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE state IN ('running','awaiting-human') AND updated_at < ?
         ORDER BY updated_at ASC`,
      )
      .all(before) as TaskRow[]
  }

  listTasks(state?: TaskState): TaskRow[] {
    return (
      state === undefined
        ? this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all()
        : this.db.prepare('SELECT * FROM tasks WHERE state = ? ORDER BY updated_at DESC').all(state)
    ) as TaskRow[]
  }

  updateTask(
    taskId: string,
    patch: Partial<Pick<TaskRow, 'thread_id' | 'state' | 'worktree' | 'spent_usd' | 'hops'>>,
    at = Date.now(),
  ): void {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      fields.push(`${k} = ?`)
      values.push(v)
    }
    fields.push('updated_at = ?')
    values.push(at, taskId)
    this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE task_id = ?`).run(...values)
  }

  /** Accumulate spend from an SDK usage callback (§6.4). Returns the new total. */
  addSpend(taskId: string, usd: number, at = Date.now()): number {
    return this.tx(() => {
      this.db
        .prepare('UPDATE tasks SET spent_usd = spent_usd + ?, updated_at = ? WHERE task_id = ?')
        .run(Math.max(0, usd), at, taskId)
      return this.getTask(taskId)?.spent_usd ?? 0
    })
  }

  /* ----------------------------------------------------------- sessions */

  getSession(threadId: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE thread_id = ?').get(threadId) as
      | SessionRow
      | undefined
  }

  putSession(threadId: string, patch: { session_id?: string | null; summary?: string | null }): void {
    this.tx(() => {
      const existing = this.getSession(threadId)
      const sessionId = patch.session_id !== undefined ? patch.session_id : existing?.session_id ?? null
      const summary = patch.summary !== undefined ? patch.summary : existing?.summary ?? null
      this.db
        .prepare(
          `INSERT INTO sessions (thread_id, session_id, summary) VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id, summary = excluded.summary`,
        )
        .run(threadId, sessionId, summary)
    })
  }

  /* ---------------------------------------------------------- questions */

  createQuestion(row: {
    question_id: string
    task_id: string
    asked_email: string
    state: QuestionState
    file?: string | null
    line_start?: number | null
    line_end?: number | null
    question: string
    at?: number
  }): QuestionRow {
    this.db
      .prepare(
        `INSERT INTO questions
           (question_id, task_id, asked_email, state, file, line_start, line_end, question, answer, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        row.question_id,
        row.task_id,
        row.asked_email.toLowerCase(),
        row.state,
        row.file ?? null,
        row.line_start ?? null,
        row.line_end ?? null,
        row.question,
        row.at ?? Date.now(),
      )
    return this.getQuestion(row.question_id)!
  }

  getQuestion(questionId: string): QuestionRow | undefined {
    return this.db.prepare('SELECT * FROM questions WHERE question_id = ?').get(questionId) as
      | QuestionRow
      | undefined
  }

  updateQuestion(
    questionId: string,
    patch: Partial<Pick<QuestionRow, 'state' | 'answer' | 'asked_email'>>,
  ): void {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      fields.push(`${k} = ?`)
      values.push(v)
    }
    if (fields.length === 0) return
    values.push(questionId)
    this.db.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE question_id = ?`).run(...values)
  }

  listQuestions(taskId: string, state?: QuestionState): QuestionRow[] {
    return (
      state === undefined
        ? this.db.prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY at ASC').all(taskId)
        : this.db
            .prepare('SELECT * FROM questions WHERE task_id = ? AND state = ? ORDER BY at ASC')
            .all(taskId, state)
    ) as QuestionRow[]
  }

  /** Questions in a given state across a thread's tasks — the §5.6 routing lookup. */
  findQuestionsByThread(threadId: string, state: QuestionState): QuestionRow[] {
    return this.db
      .prepare(
        `SELECT q.* FROM questions q JOIN tasks t ON t.task_id = q.task_id
         WHERE t.thread_id = ? AND q.state = ? ORDER BY q.at ASC`,
      )
      .all(threadId, state) as QuestionRow[]
  }

  /** A `sent` question addressed to this person, for outreach resume (§6.3). */
  findSentQuestionFrom(email: string): QuestionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM questions WHERE asked_email = ? AND state = 'sent' ORDER BY at DESC LIMIT 1`)
      .get(email.toLowerCase()) as QuestionRow | undefined
  }

  /* ---------------------------------------------------- outreach budget */

  outreachCount(email: string, week = weekKey()): number {
    const row = this.db
      .prepare('SELECT count FROM outreach_budget WHERE email = ? AND week = ?')
      .get(email.toLowerCase(), week) as { count: number } | undefined
    return row?.count ?? 0
  }

  /** Called when an outreach email is actually sent. Returns the new count. */
  bumpOutreach(email: string, week = weekKey()): number {
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO outreach_budget (email, week, count) VALUES (?, ?, 1)
           ON CONFLICT(email, week) DO UPDATE SET count = count + 1`,
        )
        .run(email.toLowerCase(), week)
      return this.outreachCount(email, week)
    })
  }

  /* ------------------------------------------------------------ cursors */

  getCursor(inboxId: string): number | undefined {
    const row = this.db.prepare('SELECT last_event_at FROM cursors WHERE inbox_id = ?').get(inboxId) as
      | { last_event_at: number }
      | undefined
    return row?.last_event_at
  }

  /** High-water mark only ever moves forward. */
  setCursor(inboxId: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (inbox_id, last_event_at) VALUES (?, ?)
         ON CONFLICT(inbox_id) DO UPDATE SET last_event_at = MAX(last_event_at, excluded.last_event_at)`,
      )
      .run(inboxId, at)
  }

  /* -------------------------------------------------------------- reset */

  /**
   * Wipe everything the journal remembers except the per-inbox cursors, which
   * the caller re-points at "now". Clearing those too would make the next
   * `up` replay the entire mailbox from the beginning — every old task, every
   * doctor probe — which is the opposite of a clean slate.
   */
  clearAll(): { tasks: number; seen: number; questions: number } {
    return this.tx(() => {
      const counts = {
        tasks: (this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n,
        seen: (this.db.prepare('SELECT COUNT(*) AS n FROM seen').get() as { n: number }).n,
        questions: (this.db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n,
      }
      for (const table of ['tasks', 'seen', 'questions', 'sessions', 'outreach_budget', 'notices']) {
        this.db.prepare(`DELETE FROM ${table}`).run()
      }
      return counts
    })
  }

  /** Move a cursor to `at` even if that is backwards — reset's one exception. */
  forceCursor(inboxId: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (inbox_id, last_event_at) VALUES (?, ?)
         ON CONFLICT(inbox_id) DO UPDATE SET last_event_at = excluded.last_event_at`,
      )
      .run(inboxId, at)
  }

  /* ------------------------------------------------------------ notices */

  /** True the first time this (task, kind) notice fires — "once per task" (§5.5). */
  claimNotice(taskId: string, kind: string, at = Date.now()): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO notices (task_id, kind, at) VALUES (?, ?, ?)')
        .run(taskId, kind, at).changes > 0
    )
  }
}
