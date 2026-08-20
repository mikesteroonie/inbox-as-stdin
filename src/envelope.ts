/**
 * Envelope format (§3). Machine data rides headers; prose rides the body.
 *
 * Parse rules: missing or malformed headers NEVER throw — they degrade to
 * `{ human: true }`, because human mail is the primary input, not an error
 * case. Anything unparseable is simply absent from the result.
 *
 * Q1 contingency (§3): if a receive path does not preserve custom headers
 * end-to-end, the same fields move to a trailer block in the body — a final
 * line `-- harness: {json}` — behind this same API. The parser always accepts
 * both; `encode()` emits whichever the config asks for. `harness doctor` runs
 * the round-trip probe that decides which mode a deployment needs.
 */

import { isQuestionId, isTaskId } from './ids.js'

export const PROTO_VERSION = '1'

export const HEADER = {
  proto: 'x-harness-proto',
  /**
   * @deprecated Legacy spelling from an early draft of SPEC §3, which now says
   * `x-harness-proto`. Accepted on parse only — never emitted — so that mail
   * already in flight from a peer built against the old draft still routes.
   *
   * REMOVE once no deployment has sent mail carrying it for a full
   * `budgets.dead_thread_ttl_days` window (default 14 days): past that no live
   * thread can still be quoting it. Deleting this constant and its branch in
   * `parse` is the whole removal.
   */
  protoAlias: 'x-agent-protocol',
  taskId: 'x-task-id',
  hops: 'x-hops',
  inReplyToQuestion: 'x-in-reply-to-question',
} as const

/** How outbound mail carries the envelope. Inbound parsing accepts all modes. */
export type EnvelopeMode = 'headers' | 'trailer' | 'both'

export interface EnvelopeFields {
  taskId?: string
  /** Hop count of the message being sent. Callers pass incoming + 1 (§5.8). */
  hops?: number
  inReplyToQuestion?: string
}

export interface Envelope {
  /**
   * True when the message carries no harness protocol marker — i.e. a human
   * wrote it. Fields may still be present (a well-behaved client can preserve
   * them on reply); `human` describes provenance, not emptiness.
   */
  human: boolean
  proto?: string
  taskId?: string
  /** Always a non-negative integer. Absent/garbage hop counts read as 0. */
  hops: number
  inReplyToQuestion?: string
}

const TRAILER_PREFIX = '-- harness:'

/** Encode to mail headers (§3). Values are strings; the transport passes them through. */
export function encodeHeaders(fields: EnvelopeFields): Record<string, string> {
  const out: Record<string, string> = { [HEADER.proto]: PROTO_VERSION }
  if (fields.taskId !== undefined) out[HEADER.taskId] = fields.taskId
  if (fields.hops !== undefined) out[HEADER.hops] = String(Math.max(0, Math.trunc(fields.hops)))
  if (fields.inReplyToQuestion !== undefined) {
    out[HEADER.inReplyToQuestion] = fields.inReplyToQuestion
  }
  return out
}

/** Encode to the body trailer line (Q1 fallback). Returns the line without a newline. */
export function encodeTrailer(fields: EnvelopeFields): string {
  const payload: Record<string, unknown> = { proto: PROTO_VERSION }
  if (fields.taskId !== undefined) payload.task_id = fields.taskId
  if (fields.hops !== undefined) payload.hops = Math.max(0, Math.trunc(fields.hops))
  if (fields.inReplyToQuestion !== undefined) {
    payload.in_reply_to_question = fields.inReplyToQuestion
  }
  return `${TRAILER_PREFIX} ${JSON.stringify(payload)}`
}

/**
 * Attach the envelope to an outbound message per `mode`. Returns the headers to
 * set and the (possibly trailer-appended) body.
 */
export function encode(
  fields: EnvelopeFields,
  body: string,
  mode: EnvelopeMode = 'headers',
): { headers: Record<string, string>; text: string } {
  const headers = mode === 'trailer' ? {} : encodeHeaders(fields)
  const text = mode === 'headers' ? body : `${body.replace(/\s+$/, '')}\n\n${encodeTrailer(fields)}\n`
  return { headers, text }
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
  }
  return out
}

function parseHops(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return undefined
  const i = Math.trunc(n)
  return i < 0 ? 0 : i
}

/**
 * Find the trailer in a body. It must be the LAST non-blank line, exactly as
 * `encodeTrailer` writes it. Deliberately strict: a looser scan would read a
 * trailer that a human quoted back at us as if it were live routing data.
 */
function findTrailer(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  const lines = text.split(/\r?\n/)
  let i = lines.length - 1
  while (i >= 0 && lines[i]!.trim() === '') i--
  if (i < 0) return undefined
  const line = lines[i]!.trim()
  if (!line.startsWith(TRAILER_PREFIX)) return undefined
  try {
    const parsed: unknown = JSON.parse(line.slice(TRAILER_PREFIX.length).trim())
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // A malformed trailer is not an error — human mail may contain anything.
  }
  return undefined
}

/**
 * Parse an inbound message's envelope. Headers win over the trailer when both
 * are present and disagree; neither ever throws.
 */
export function parse(headers?: Record<string, string>, text?: string): Envelope {
  const h = lowerKeys(headers)
  const t = findTrailer(text)

  const protoRaw =
    h[HEADER.proto] ??
    h[HEADER.protoAlias] ??
    (typeof t?.proto === 'string' ? t.proto : undefined)
  const proto = protoRaw?.trim() || undefined

  const taskRaw =
    h[HEADER.taskId] ?? (typeof t?.task_id === 'string' ? (t.task_id as string) : undefined)
  const taskId = taskRaw && isTaskId(taskRaw.trim()) ? taskRaw.trim() : undefined

  const hopsRaw =
    parseHops(h[HEADER.hops]) ??
    (typeof t?.hops === 'number' && Number.isFinite(t.hops) ? Math.max(0, Math.trunc(t.hops)) : undefined)

  const qRaw =
    h[HEADER.inReplyToQuestion] ??
    (typeof t?.in_reply_to_question === 'string' ? (t.in_reply_to_question as string) : undefined)
  const inReplyToQuestion = qRaw && isQuestionId(qRaw.trim()) ? qRaw.trim() : undefined

  const env: Envelope = { human: proto === undefined, hops: hopsRaw ?? 0 }
  if (proto !== undefined) env.proto = proto
  if (taskId !== undefined) env.taskId = taskId
  if (inReplyToQuestion !== undefined) env.inReplyToQuestion = inReplyToQuestion
  return env
}

/**
 * Remove a trailer line from a body before the text is rendered into a prompt
 * or shown to a human. Idempotent on bodies that have none.
 */
export function stripTrailer(text: string): string {
  const lines = text.split(/\r?\n/)
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') end--
  if (end > 0 && lines[end - 1]!.trim().startsWith(TRAILER_PREFIX)) {
    return lines.slice(0, end - 1).join('\n').replace(/\s+$/, '')
  }
  return text
}
