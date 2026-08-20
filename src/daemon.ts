/**
 * Connection lifecycle (§0, §11): connect, subscribe, reconnect, dispatch.
 *
 * Two things this file owns that nothing else may:
 *
 *   Reconnect — exponential backoff with jitter, 1s → 60s cap, resubscribe on
 *   reconnect, and a backlog poll after every (re)connect so a message that
 *   arrived during an outage is still processed (§10 milestone 1).
 *
 *   Concurrency — events are processed serially per thread and in parallel
 *   across threads: a per-thread FIFO over a worker pool of
 *   `budgets.max_concurrent` (default 3). Two messages on one thread never
 *   race; two tasks never block each other.
 */

import type { HarnessConfig } from './config.js'
import { budgetsFor } from './config.js'
import { dispatch, inboxOf, type Deps, type DispatchResult } from './dispatch.js'
import { logger } from './log.js'
import type { MailEvent, MailTransport, Subscription } from './transport/types.js'

const log = logger('daemon')

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** Overlap the backlog window with the cursor so nothing falls between (§11). */
const BACKLOG_OVERLAP_MS = 120_000

export interface DaemonOptions extends Deps {
  /** Test seam for backoff sleeps. */
  sleep?: (ms: number) => Promise<void>
  /** Test seam for jitter. */
  random?: () => number
}

/** Backoff for attempt n (0-based): 1s, 2s, 4s … capped at 60s, ±25% jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt))
  const jitter = base * 0.25 * (random() * 2 - 1)
  return Math.max(BACKOFF_MIN_MS, Math.round(base + jitter))
}

/* ------------------------------------------------------------- queueing */

/**
 * Per-thread FIFO over a bounded worker pool. `submit` returns a promise that
 * settles when that event has been dispatched, which is what makes `--once`
 * and the tests deterministic.
 */
export class ThreadQueue {
  private readonly queues = new Map<string, (() => Promise<void>)[]>()
  private readonly running = new Set<string>()
  private active = 0
  private readonly pending: string[] = []

  constructor(private readonly limit: number) {}

  submit<T>(key: string, job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const wrapped = async (): Promise<void> => {
        try {
          resolve(await job())
        } catch (err) {
          reject(err)
        }
      }
      const q = this.queues.get(key) ?? []
      q.push(wrapped)
      this.queues.set(key, q)
      if (!this.pending.includes(key) && !this.running.has(key)) this.pending.push(key)
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.limit && this.pending.length > 0) {
      const key = this.pending.shift()!
      if (this.running.has(key)) continue
      const q = this.queues.get(key)
      const job = q?.shift()
      if (!job) {
        this.queues.delete(key)
        continue
      }
      this.running.add(key)
      this.active++
      void job().finally(() => {
        this.active--
        this.running.delete(key)
        const rest = this.queues.get(key)
        if (rest && rest.length > 0) this.pending.push(key)
        else this.queues.delete(key)
        this.pump()
      })
    }
  }

  get idle(): boolean {
    return this.active === 0 && this.pending.length === 0
  }

  /** Resolve once every submitted job has settled. */
  async drain(): Promise<void> {
    while (!this.idle) await new Promise((r) => setTimeout(r, 5))
  }
}

/* --------------------------------------------------------------- daemon */

export class Daemon {
  private readonly queue: ThreadQueue
  private subscriptions: Subscription[] = []
  private stopped = false
  private attempt = 0
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(private readonly opts: DaemonOptions) {
    const maxConcurrent = budgetsFor(opts.cfg).maxConcurrent
    this.queue = new ThreadQueue(maxConcurrent)
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.random = opts.random ?? Math.random
  }

  /** Run the backlog once and exit — `harness up --once`. */
  async runOnce(): Promise<DispatchResult[]> {
    const results = await this.replayBacklog()
    await this.queue.drain()
    this.opts.store.pruneSeen()
    return results
  }

  /** Run until `stop()`. Resolves when stopped. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connect()
        this.attempt = 0
        await this.replayBacklog()
        await this.waitForDisconnect()
      } catch (err) {
        log.error('connection attempt failed', { err: String(err), attempt: this.attempt })
      }
      if (this.stopped) break
      const wait = backoffMs(this.attempt++, this.random)
      log.warn('reconnecting', { inMs: wait, attempt: this.attempt })
      await this.sleep(wait)
    }
    await this.queue.drain()
  }

  stop(): void {
    this.stopped = true
    for (const sub of this.subscriptions) sub.stop()
    this.subscriptions = []
    this.disconnected?.()
  }

  private disconnected: (() => void) | undefined

  private waitForDisconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.disconnected = () => {
        this.disconnected = undefined
        resolve()
      }
    })
  }

  /** Subscribe every roster inbox. One transport per agent, per §0. */
  private async connect(): Promise<void> {
    for (const sub of this.subscriptions) sub.stop()
    this.subscriptions = []

    for (const [agentName, transport] of this.opts.transports) {
      const agent = this.opts.cfg.agents.find((a) => a.name === agentName)
      if (!agent) continue
      const sub = await transport.listen(
        {
          ...(this.opts.cfg.pod_id ? { podId: this.opts.cfg.pod_id } : {}),
          inboxIds: [inboxOf(agent)],
        },
        (event) => this.enqueue(event),
        {
          onClose: (info) => {
            log.warn('websocket closed', { agent: agentName, ...info })
            this.disconnected?.()
          },
          onError: (err) => log.error('websocket error', { agent: agentName, err: err.message }),
        },
      )
      this.subscriptions.push(sub)
      log.info('listening', { agent: agentName, inbox: inboxOf(agent) })
    }
  }

  /** §11 — feed anything unseen since the high-water mark through dispatch. */
  private async replayBacklog(): Promise<DispatchResult[]> {
    const results: DispatchResult[] = []
    const jobs: Promise<DispatchResult>[] = []
    for (const [agentName, transport] of this.opts.transports) {
      const agent = this.opts.cfg.agents.find((a) => a.name === agentName)
      if (!agent) continue
      const inbox = inboxOf(agent)
      const cursor = this.opts.store.getCursor(inbox)
      const since = cursor === undefined ? 0 : Math.max(0, cursor - BACKLOG_OVERLAP_MS)
      let refs: Awaited<ReturnType<MailTransport['listSince']>>
      try {
        refs = await transport.listSince(inbox, since)
      } catch (err) {
        log.error('backlog poll failed', { agent: agentName, err: String(err) })
        continue
      }
      if (refs.length > 0) log.info('backlog', { agent: agentName, messages: refs.length, since })
      for (const ref of refs) {
        // Dedupe (§5.1) makes over-fetch harmless.
        if (this.opts.store.hasSeen(ref.messageId)) continue
        jobs.push(
          this.enqueue({
            kind: 'message.received',
            inboxId: ref.inboxId,
            messageId: ref.messageId,
            threadId: ref.threadId,
            at: ref.at,
          }),
        )
      }
    }
    for (const job of jobs) results.push(await job)
    return results
  }

  private enqueue(event: MailEvent): Promise<DispatchResult> {
    const key = 'threadId' in event && event.threadId ? event.threadId : event.messageId
    return this.queue.submit(key, async () => {
      try {
        const result = await dispatch(this.opts, event)
        this.opts.store.setCursor(event.inboxId, event.at)
        log.info('dispatched', {
          disposition: result.disposition,
          ...(result.taskId ? { task: result.taskId } : {}),
          ...(result.detail ? { detail: result.detail } : {}),
        })
        return result
      } catch (err) {
        log.error('dispatch threw', { messageId: event.messageId, err: String(err) })
        return { disposition: 'error' as const, detail: String(err) }
      }
    })
  }
}

export function daemonFor(opts: DaemonOptions): Daemon {
  return new Daemon(opts)
}

export type { HarnessConfig }
