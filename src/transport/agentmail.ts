/**
 * AgentMail implementation of MailTransport (§2). The only complete one.
 *
 * Provider types stop here: everything crossing the interface boundary is one
 * of the plain shapes in `./types.ts`.
 *
 * On the websocket: the SDK ships a reconnecting socket, and we deliberately
 * turn it off (`reconnectAttempts: 0`). §0 puts reconnect policy — exponential
 * backoff with jitter, resubscribe, backlog replay — in the daemon, where it
 * can be coordinated with the cursor table. A transport that silently
 * reconnected underneath would skip the backlog poll and lose messages.
 */

import { AgentMailClient } from 'agentmail'
import type { AgentMail } from 'agentmail'
import { logger } from '../log.js'
import { normalizeAddress } from '../policy.js'
import { extractReply } from '../reply.js'
import type {
  ArmorVerdict,
  MailEvent,
  MailTransport,
  Message,
  MessageRef,
  OutboundMessage,
  OutboundReply,
  Subscription,
  Thread,
} from './types.js'

const log = logger('transport')

/** Event types we subscribe to. Everything else is noise for this harness. */
const EVENT_TYPES = ['message.received', 'message.bounced', 'message.rejected'] as const

export interface AgentMailTransportOptions {
  apiKey: string
  /** Domain for inboxes created by `ensureInbox`. Defaults to the org default. */
  domain?: string
  /** Pod the inboxes belong to; used as the websocket subscription scope. */
  podId?: string
  baseUrl?: string
}

export class AgentMailTransport implements MailTransport {
  private readonly client: AgentMailClient
  private readonly opts: AgentMailTransportOptions

  constructor(opts: AgentMailTransportOptions) {
    this.opts = opts
    this.client = new AgentMailClient({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    })
  }

  /** Escape hatch for `init`/`doctor`, which need provider-level calls. */
  get raw(): AgentMailClient {
    return this.client
  }

  /* ------------------------------------------------------------ identity */

  async ensureInbox(username: string, displayName: string): Promise<{ inboxId: string; email: string }> {
    const existing = await this.findInbox(username)
    if (existing) return existing
    try {
      const inbox = await this.client.inboxes.create({
        username,
        displayName,
        // clientId makes creation idempotent across reruns of `harness init`.
        clientId: `harness:${username}`,
        ...(this.opts.domain ? { domain: this.opts.domain } : {}),
      })
      return { inboxId: inbox.inboxId, email: inbox.email }
    } catch (err) {
      // A concurrent create (or a pre-existing clientId) races us; re-read.
      const found = await this.findInbox(username)
      if (found) return found
      throw err
    }
  }

  private async findInbox(username: string): Promise<{ inboxId: string; email: string } | undefined> {
    const local = username.toLowerCase()
    let pageToken: string | undefined
    do {
      const page = await this.client.inboxes.list(pageToken ? { pageToken } : {})
      for (const inbox of page.inboxes) {
        if (inbox.email.toLowerCase().split('@')[0] === local) {
          return { inboxId: inbox.inboxId, email: inbox.email }
        }
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    return undefined
  }

  /* ------------------------------------------------------------- wake-up */

  async listen(
    scope: { podId?: string; inboxIds?: string[] },
    onEvent: (e: MailEvent) => void,
    hooks?: {
      onClose?: (info: { code?: number; reason?: string }) => void
      onError?: (err: Error) => void
    },
  ): Promise<Subscription> {
    const socket = await this.client.websockets.connect({
      reconnectAttempts: 0, // §0: the daemon owns reconnect policy.
      waitForOpen: true,
    })

    let stopped = false

    socket.on('message', (raw) => {
      const event = toMailEvent(raw)
      if (event) onEvent(event)
      else if (raw.type === 'error') {
        hooks?.onError?.(new Error(`${raw.name}: ${raw.message}`))
      } else if (raw.type === 'subscribed') {
        log.info('subscribed', { pod: scope.podId ?? '(all)', inboxes: raw.inboxIds?.length ?? 0 })
      }
    })
    socket.on('close', (event) => {
      if (stopped) return
      hooks?.onClose?.({ code: event.code, reason: event.reason })
    })
    socket.on('error', (err) => {
      if (stopped) return
      hooks?.onError?.(err)
    })

    socket.sendSubscribe({
      type: 'subscribe',
      eventTypes: [...EVENT_TYPES],
      ...(scope.podId ? { podIds: [scope.podId] } : {}),
      ...(scope.inboxIds?.length ? { inboxIds: scope.inboxIds } : {}),
    })

    return {
      stop: () => {
        stopped = true
        try {
          socket.close()
        } catch (err) {
          log.debug('socket close threw', { err: String(err) })
        }
      },
    }
  }

  /* ---------------------------------------------------------------- read */

  async getMessage(inboxId: string, messageId: string): Promise<Message> {
    return toMessage(await this.client.inboxes.messages.get(inboxId, messageId))
  }

  async getThread(inboxId: string, threadId: string): Promise<Thread> {
    const thread = await this.client.inboxes.threads.get(inboxId, threadId)
    const messages = thread.messages.map(toMessage)
    const participants = new Set<string>()
    for (const m of messages) {
      for (const addr of [m.from, ...m.to, ...m.cc]) {
        const n = normalizeAddress(addr)
        if (n) participants.add(n)
      }
    }
    return {
      inboxId: thread.inboxId,
      threadId: thread.threadId,
      ...(thread.subject !== undefined ? { subject: thread.subject } : {}),
      labels: thread.labels ?? [],
      messages,
      participants: [...participants],
    }
  }

  async listSince(inboxId: string, since: number, limit = 50): Promise<MessageRef[]> {
    const page = await this.client.inboxes.messages.list(inboxId, {
      after: new Date(since),
      limit,
      ascending: true,
    })
    return page.messages.map((m) => ({
      inboxId: m.inboxId,
      messageId: m.messageId,
      threadId: m.threadId,
      at: timestampOf(m.timestamp),
    }))
  }

  /* --------------------------------------------------------------- write */

  async send(inboxId: string, msg: OutboundMessage): Promise<{ messageId: string; threadId: string }> {
    const res = await this.client.inboxes.messages.send(inboxId, {
      to: msg.to,
      ...(msg.cc?.length ? { cc: msg.cc } : {}),
      subject: msg.subject,
      text: msg.text,
      ...(msg.headers ? { headers: msg.headers } : {}),
      ...(msg.labels?.length ? { labels: msg.labels } : {}),
      ...(msg.attachments?.length ? { attachments: msg.attachments.map(toSendAttachment) } : {}),
    })
    return { messageId: res.messageId, threadId: res.threadId }
  }

  async reply(inboxId: string, messageId: string, msg: OutboundReply): Promise<{ messageId: string }> {
    const res = await this.client.inboxes.messages.reply(inboxId, messageId, {
      text: msg.text,
      ...(msg.to?.length ? { to: msg.to } : {}),
      ...(msg.cc?.length ? { cc: msg.cc } : {}),
      ...(msg.headers ? { headers: msg.headers } : {}),
      ...(msg.labels?.length ? { labels: msg.labels } : {}),
      ...(msg.attachments?.length ? { attachments: msg.attachments.map(toSendAttachment) } : {}),
    })
    return { messageId: res.messageId }
  }

  async label(inboxId: string, threadId: string, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return
    await this.client.inboxes.threads.update(inboxId, threadId, {
      ...(add.length ? { addLabels: add } : {}),
      ...(remove.length ? { removeLabels: remove } : {}),
    })
  }
}

/* ------------------------------------------------------------- mapping */

function toSendAttachment(a: {
  filename: string
  contentType?: string
  content: string
}): AgentMail.SendAttachment {
  return {
    filename: a.filename,
    content: a.content,
    ...(a.contentType ? { contentType: a.contentType } : {}),
  }
}

function timestampOf(value: Date | string | number | undefined): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v
  return out
}

/**
 * Agent Armor verdict. AgentMail surfaces this out-of-band of the typed SDK,
 * so we read it from whichever channel carries it and fall back to the
 * provider's own safety labels: spam, blocked, and unauthenticated mail is
 * held for review rather than fed to a prompt (§5.3).
 */
export function armorOf(headers: Record<string, string>, labels: string[]): ArmorVerdict | undefined {
  const raw =
    headers['x-agentmail-armor-verdict'] ?? headers['x-armor-verdict'] ?? headers['x-agent-armor']
  if (raw) {
    const v = raw.trim().toLowerCase()
    const reason = headers['x-agentmail-armor-reason'] ?? headers['x-armor-reason']
    if (v === 'pass' || v === 'review' || v === 'block') {
      return { verdict: v, ...(reason ? { reason } : {}) }
    }
  }
  const lower = labels.map((l) => l.toLowerCase())
  const armorLabel = lower.find((l) => l.startsWith('armor/'))
  if (armorLabel) {
    const v = armorLabel.slice('armor/'.length)
    if (v === 'pass' || v === 'review' || v === 'block') return { verdict: v, reason: armorLabel }
  }
  for (const flag of ['blocked', 'spam', 'unauthenticated']) {
    if (lower.includes(flag)) return { verdict: 'review', reason: `provider label: ${flag}` }
  }
  return undefined
}

function addresses(value: string[] | string | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function toMessage(m: AgentMail.Message): Message {
  const headers = lowerHeaders(m.headers)
  const labels = m.labels ?? []
  const text = m.text ?? m.preview ?? ''
  const armor = armorOf(headers, labels)
  return {
    inboxId: m.inboxId,
    messageId: m.messageId,
    threadId: m.threadId,
    from: m.from,
    to: addresses(m.to),
    cc: addresses(m.cc),
    ...(m.subject !== undefined ? { subject: m.subject } : {}),
    text,
    // Prefer the provider's Talon-based extraction; fall back to ours (§11).
    extractedText: m.extractedText?.trim() ? m.extractedText : extractReply(text),
    headers,
    labels,
    attachments: (m.attachments ?? []).map((a: AgentMail.Attachment) => ({
      attachmentId: a.attachmentId,
      ...(a.filename !== undefined ? { filename: a.filename } : {}),
      ...(a.contentType !== undefined ? { contentType: a.contentType } : {}),
      ...(a.size !== undefined ? { size: a.size } : {}),
    })),
    timestamp: timestampOf(m.timestamp),
    ...(armor ? { armor } : {}),
  }
}

/** Map a raw websocket frame onto the MailEvent union. Unknown frames → undefined. */
interface RawFrame {
  type?: string
  eventType?: string
  message?: { inboxId: string; messageId: string; threadId: string; timestamp?: Date | string }
  bounce?: {
    inboxId: string
    messageId: string
    threadId?: string
    recipients?: { address: string }[]
    timestamp?: Date | string
    type?: string
    subType?: string
  }
  reject?: {
    inboxId: string
    messageId: string
    threadId?: string
    reason?: string
    timestamp?: Date | string
  }
}

export function toMailEvent(frame: unknown): MailEvent | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const raw = frame as RawFrame
  if (raw.type !== 'event') return undefined
  switch (raw.eventType) {
    case 'message.received':
    case 'message.received.spam':
    case 'message.received.blocked':
    case 'message.received.unauthenticated': {
      // Spam/blocked/unauthenticated still enter the pipeline: the armor gate
      // (§5.3) holds them and notifies, which beats dropping them silently.
      if (!raw.message) return undefined
      return {
        kind: 'message.received',
        inboxId: raw.message.inboxId,
        messageId: raw.message.messageId,
        threadId: raw.message.threadId,
        at: timestampOf(raw.message.timestamp),
      }
    }
    case 'message.bounced': {
      if (!raw.bounce) return undefined
      return {
        kind: 'message.bounced',
        inboxId: raw.bounce.inboxId,
        messageId: raw.bounce.messageId,
        ...(raw.bounce.threadId ? { threadId: raw.bounce.threadId } : {}),
        recipients: (raw.bounce.recipients ?? []).map((r) => r.address),
        ...(raw.bounce.subType ? { reason: `${raw.bounce.type ?? 'bounce'}/${raw.bounce.subType}` } : {}),
        at: timestampOf(raw.bounce.timestamp),
      }
    }
    case 'message.rejected': {
      if (!raw.reject) return undefined
      return {
        kind: 'message.rejected',
        inboxId: raw.reject.inboxId,
        messageId: raw.reject.messageId,
        ...(raw.reject.threadId ? { threadId: raw.reject.threadId } : {}),
        recipients: [],
        ...(raw.reject.reason ? { reason: raw.reject.reason } : {}),
        at: timestampOf(raw.reject.timestamp),
      }
    }
    default:
      return undefined
  }
}
