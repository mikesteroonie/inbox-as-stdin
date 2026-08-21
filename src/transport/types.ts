/**
 * MailTransport (§2). Everything the daemon and the harness know about email
 * goes through this interface. AgentMail is the only complete implementation;
 * the interface exists so the pattern stays open.
 *
 * The transport maps provider fields into these types — the harness never sees
 * provider types.
 */

export interface Address {
  /** Normalized `user@host`. */
  email: string
  name?: string
}

export interface Attachment {
  attachmentId?: string
  filename?: string
  contentType?: string
  size?: number
}

export interface OutboundAttachment {
  filename: string
  contentType?: string
  /** Base64-encoded content. */
  content: string
}

/**
 * Agent Armor verdict, when the provider supplies one. `review` holds the
 * message before it can reach a prompt (§5.3).
 */
export interface ArmorVerdict {
  verdict: 'pass' | 'review' | 'block'
  reason?: string
}

export interface Message {
  inboxId: string
  messageId: string
  threadId: string
  from: string
  to: string[]
  cc: string[]
  subject?: string
  /** Full body text as delivered. */
  text: string
  /**
   * Body with quoted history removed. The transport prefers the provider's
   * extraction and falls back to `extractReply` (§11).
   */
  extractedText: string
  headers: Record<string, string>
  labels: string[]
  attachments: Attachment[]
  /** Epoch millis the provider recorded for the message. */
  timestamp: number
  armor?: ArmorVerdict
}

export interface Thread {
  inboxId: string
  threadId: string
  subject?: string
  labels: string[]
  messages: Message[]
  /** Every address that has appeared on the thread, normalized and deduped. */
  participants: string[]
}

export interface OutboundMessage {
  to: string[]
  cc?: string[]
  subject: string
  text: string
  headers?: Record<string, string>
  attachments?: OutboundAttachment[]
  labels?: string[]
}

export interface OutboundReply {
  text: string
  to?: string[]
  cc?: string[]
  headers?: Record<string, string>
  attachments?: OutboundAttachment[]
  labels?: string[]
}

export type MailEvent =
  | { kind: 'message.received'; inboxId: string; messageId: string; threadId: string; at: number }
  | {
      kind: 'message.bounced' | 'message.rejected'
      inboxId: string
      messageId: string
      threadId?: string
      recipients: string[]
      reason?: string
      at: number
    }

export interface Subscription {
  stop(): void
}

/** Lightweight message reference used by backlog recovery (§11). */
export interface MessageRef {
  inboxId: string
  messageId: string
  threadId: string
  at: number
}

/**
 * The requested inbox username is already in use. Carries whatever
 * alternatives the provider offered, so a caller can present a choice rather
 * than a dead end. A domain error, not a provider one — §2 keeps provider
 * types on the far side of this interface.
 */
export class InboxTakenError extends Error {
  constructor(
    readonly username: string,
    readonly suggestions: readonly string[],
  ) {
    super(
      `The inbox "${username}" is already taken` +
        (suggestions.length > 0 ? `. Available: ${suggestions.join(', ')}` : ''),
    )
    this.name = 'InboxTakenError'
  }
}

export interface MailTransport {
  // identity
  ensureInbox(username: string, displayName: string): Promise<{ inboxId: string; email: string }>

  /**
   * Wake-up: resolves when subscribed; `onEvent` fires for every event until
   * `stop()` is called. Reconnection is the caller's business (§0) — the
   * transport reports a dropped connection by invoking `onClose` and does not
   * silently resubscribe behind the daemon's back.
   */
  listen(
    scope: { podId?: string; inboxIds?: string[] },
    onEvent: (e: MailEvent) => void,
    hooks?: { onClose?: (info: { code?: number; reason?: string }) => void; onError?: (err: Error) => void },
  ): Promise<Subscription>

  // read
  getMessage(inboxId: string, messageId: string): Promise<Message>
  getThread(inboxId: string, threadId: string): Promise<Thread>
  /** Backlog recovery (§11): messages received at or after `since`. */
  listSince(inboxId: string, since: number, limit?: number): Promise<MessageRef[]>

  // write
  send(inboxId: string, msg: OutboundMessage): Promise<{ messageId: string; threadId: string }>
  reply(inboxId: string, messageId: string, msg: OutboundReply): Promise<{ messageId: string }>
  label(inboxId: string, threadId: string, add: string[], remove: string[]): Promise<void>
}

/** Labels the harness sets on threads. Kept here so both sides agree. */
export const LABEL = {
  held: 'state/held',
  running: 'state/running',
  awaitingHuman: 'state/awaiting-human',
  // SPEC §3 names this one; it describes what happened on the thread rather
  // than the internal task state, which is the right thing for a mail client.
  replied: 'state/replied',
  failed: 'state/failed',
} as const

export const STATE_LABELS: string[] = Object.values(LABEL)
