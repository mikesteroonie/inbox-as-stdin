/**
 * In-memory MailTransport. Not a shipping backend — it exists so the dispatch
 * pipeline (§5), the guards (§6) and the daemon's reconnect/backlog logic can
 * be tested without a network or an account, which is what makes the §10
 * acceptance criteria checkable in CI.
 */

import { normalizeAddress } from '../policy.js'
import { extractReply } from '../reply.js'
import type {
  MailEvent,
  MailTransport,
  Message,
  MessageRef,
  OutboundMessage,
  OutboundReply,
  Subscription,
  Thread,
} from './types.js'

export interface SentRecord {
  inboxId: string
  kind: 'send' | 'reply'
  inReplyTo?: string
  to: string[]
  cc: string[]
  subject: string
  text: string
  headers: Record<string, string>
  attachments: { filename: string; contentType?: string; content: string }[]
  messageId: string
  threadId: string
}

let counter = 0
const nextId = (prefix: string): string => `${prefix}_${(++counter).toString(36).padStart(6, '0')}`

export class MemoryTransport implements MailTransport {
  readonly messages = new Map<string, Message>()
  readonly threadLabels = new Map<string, Set<string>>()
  /** Everything the harness sent, in order — the assertion surface for tests. */
  readonly sent: SentRecord[] = []
  readonly inboxes = new Map<string, string>()

  private listeners: ((e: MailEvent) => void)[] = []
  private closeHooks: ((info: { code?: number; reason?: string }) => void)[] = []
  /** Set while "disconnected", to model a network outage (§10 milestone 1). */
  private online = true
  /** Set to model a server that accepts the socket then refuses the scope. */
  private subscribeError: string | undefined

  async ensureInbox(username: string, displayName: string): Promise<{ inboxId: string; email: string }> {
    const email = username.includes('@') ? username : `${username}@memory.test`
    this.inboxes.set(email, displayName)
    return { inboxId: email, email }
  }

  async listen(
    _scope: { podId?: string; inboxIds?: string[] },
    onEvent: (e: MailEvent) => void,
    hooks?: { onClose?: (info: { code?: number; reason?: string }) => void },
  ): Promise<Subscription> {
    // An open socket is not a subscribed one: the real transport rejects here
    // when the server refuses the scope, and callers must see that.
    if (this.subscribeError !== undefined) throw new Error(this.subscribeError)
    this.listeners.push(onEvent)
    if (hooks?.onClose) this.closeHooks.push(hooks.onClose)
    return {
      stop: () => {
        this.listeners = this.listeners.filter((l) => l !== onEvent)
      },
    }
  }

  async getMessage(_inboxId: string, messageId: string): Promise<Message> {
    const m = this.messages.get(messageId)
    if (!m) throw new Error(`no such message: ${messageId}`)
    return m
  }

  async getThread(inboxId: string, threadId: string): Promise<Thread> {
    const messages = [...this.messages.values()]
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.timestamp - b.timestamp)
    const participants = new Set<string>()
    for (const m of messages) {
      for (const a of [m.from, ...m.to, ...m.cc]) {
        const n = normalizeAddress(a)
        if (n) participants.add(n)
      }
    }
    return {
      inboxId,
      threadId,
      ...(messages[0]?.subject !== undefined ? { subject: messages[0].subject } : {}),
      labels: [...(this.threadLabels.get(threadId) ?? [])],
      messages,
      participants: [...participants],
    }
  }

  async listSince(inboxId: string, since: number, limit = 50): Promise<MessageRef[]> {
    return [...this.messages.values()]
      .filter((m) => m.inboxId === inboxId && m.timestamp >= since)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, limit)
      .map((m) => ({ inboxId: m.inboxId, messageId: m.messageId, threadId: m.threadId, at: m.timestamp }))
  }

  async send(inboxId: string, msg: OutboundMessage): Promise<{ messageId: string; threadId: string }> {
    const messageId = nextId('msg')
    const threadId = nextId('thr')
    this.record({ inboxId, kind: 'send', msg, messageId, threadId, subject: msg.subject, to: msg.to })
    return { messageId, threadId }
  }

  async reply(inboxId: string, messageId: string, msg: OutboundReply): Promise<{ messageId: string }> {
    const parent = this.messages.get(messageId)
    const newId = nextId('msg')
    this.record({
      inboxId,
      kind: 'reply',
      inReplyTo: messageId,
      msg,
      messageId: newId,
      threadId: parent?.threadId ?? nextId('thr'),
      subject: parent?.subject ? `Re: ${parent.subject}` : '(reply)',
      to: msg.to ?? (parent ? [parent.from] : []),
    })
    return { messageId: newId }
  }

  private record(args: {
    inboxId: string
    kind: 'send' | 'reply'
    inReplyTo?: string
    msg: OutboundMessage | OutboundReply
    messageId: string
    threadId: string
    subject: string
    to: string[]
  }): void {
    this.sent.push({
      inboxId: args.inboxId,
      kind: args.kind,
      ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}),
      to: args.to,
      cc: args.msg.cc ?? [],
      subject: args.subject,
      text: args.msg.text,
      headers: args.msg.headers ?? {},
      attachments: args.msg.attachments ?? [],
      messageId: args.messageId,
      threadId: args.threadId,
    })
  }

  async label(_inboxId: string, threadId: string, add: string[], remove: string[]): Promise<void> {
    const set = this.threadLabels.get(threadId) ?? new Set<string>()
    for (const l of add) set.add(l)
    for (const l of remove) set.delete(l)
    this.threadLabels.set(threadId, set)
  }

  /* ------------------------------------------------------- test controls */

  /** Deliver an inbound message. Fires an event only while "online". */
  deliver(partial: Partial<Message> & { from: string; inboxId: string; text: string }): Message {
    const message: Message = {
      messageId: partial.messageId ?? nextId('msg'),
      threadId: partial.threadId ?? nextId('thr'),
      inboxId: partial.inboxId,
      from: partial.from,
      to: partial.to ?? [partial.inboxId],
      cc: partial.cc ?? [],
      ...(partial.subject !== undefined ? { subject: partial.subject } : {}),
      text: partial.text,
      extractedText: partial.extractedText ?? extractReply(partial.text),
      headers: partial.headers ?? {},
      labels: partial.labels ?? [],
      attachments: partial.attachments ?? [],
      timestamp: partial.timestamp ?? Date.now(),
      ...(partial.armor ? { armor: partial.armor } : {}),
    }
    this.messages.set(message.messageId, message)
    if (this.online) this.emit({ kind: 'message.received', inboxId: message.inboxId, messageId: message.messageId, threadId: message.threadId, at: message.timestamp })
    return message
  }

  emit(event: MailEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  /** Model an outage: messages still land, but no events are delivered. */
  goOffline(): void {
    this.online = false
    for (const hook of [...this.closeHooks]) hook({ code: 1006, reason: 'test outage' })
  }

  goOnline(): void {
    this.online = true
  }

  /** Model the server refusing the subscription scope. */
  refuseSubscribe(reason = 'An inbox-scoped connection cannot subscribe to pods.'): void {
    this.subscribeError = reason
  }

  allowSubscribe(): void {
    this.subscribeError = undefined
  }
}
