/**
 * Policy (§6). Default-deny outreach tiers, loop guards, and budgets.
 *
 * Every function here is pure: inputs in, verdict out, no I/O. That is what
 * makes this module the one place the guards can be exhaustively tested — and
 * §10 requires the guards to exist before the first agent session runs.
 */

/** Outreach tier for a prospective recipient (§6.1). */
export type Tier = 'auto' | 'ask' | 'never'

export interface TierVerdict {
  tier: Tier
  /** Which rule matched, for the log line and the message back to the session. */
  reason:
    | 'thread-participant'
    | 'pod-roster'
    | 'allowlist-domain'
    | 'allowlist-email'
    | 'default-deny'
    | 'invalid-address'
}

export interface TierInput {
  recipient: string
  /** Addresses already on this thread (from/to/cc across its messages). */
  threadParticipants?: readonly string[]
  /** Agent inbox addresses in this pod. */
  roster?: readonly string[]
  /** Domains eligible for tier-ask. */
  allowlistDomains?: readonly string[]
  /**
   * Individual addresses eligible for tier-ask. Narrower than a domain and
   * checked the same way: naming one person is how you get a genuinely
   * single-human blast radius, which a domain entry cannot express.
   */
  allowlistEmails?: readonly string[]
}

/**
 * Normalize `Display Name <User@Example.COM>` to `user@example.com`.
 * Returns undefined when there is no plausible address to extract — callers
 * treat that as tier-never rather than guessing.
 */
export function normalizeAddress(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined
  let s = raw.trim()
  // One address in, one address out. A string carrying several angle-bracket
  // groups is an address list, and picking one of them silently is how a
  // sender gate gets fooled.
  const groups = s.match(/<[^<>]*>/g)
  if (groups && groups.length > 1) return undefined
  const angled = s.match(/<([^<>]*)>\s*$/)
  if (angled) s = angled[1]!.trim()
  s = s.replace(/^mailto:/i, '').trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) s = s.slice(1, -1).trim()
  const at = s.lastIndexOf('@')
  if (at <= 0 || at === s.length - 1) return undefined
  if (/[\s,;<>]/.test(s)) return undefined
  const domain = s.slice(at + 1)
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return undefined
  return s.toLowerCase()
}

export function domainOf(address: string): string | undefined {
  const normalized = normalizeAddress(address)
  if (normalized === undefined) return undefined
  return normalized.slice(normalized.lastIndexOf('@') + 1)
}

function normalizeAll(list: readonly string[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const item of list ?? []) {
    const n = normalizeAddress(item)
    if (n !== undefined) out.add(n)
  }
  return out
}

/**
 * Domain match is exact or a subdomain of an allowlisted domain: `yourco.dev`
 * covers `mail.yourco.dev` but never `notyourco.dev`.
 */
export function domainAllowed(
  address: string,
  allowlistDomains: readonly string[] | undefined,
): boolean {
  const domain = domainOf(address)
  if (domain === undefined) return false
  for (const raw of allowlistDomains ?? []) {
    const d = raw.trim().toLowerCase().replace(/^[.@]+/, '')
    if (d === '') continue
    if (domain === d || domain.endsWith(`.${d}`)) return true
  }
  return false
}

/** §6.1, evaluated in order; first match wins. Anything unmatched is `never`. */
export function classifyRecipient(input: TierInput): TierVerdict {
  const recipient = normalizeAddress(input.recipient)
  if (recipient === undefined) return { tier: 'never', reason: 'invalid-address' }
  if (normalizeAll(input.threadParticipants).has(recipient)) {
    return { tier: 'auto', reason: 'thread-participant' }
  }
  if (normalizeAll(input.roster).has(recipient)) {
    return { tier: 'auto', reason: 'pod-roster' }
  }
  if (normalizeAll(input.allowlistEmails).has(recipient)) {
    return { tier: 'ask', reason: 'allowlist-email' }
  }
  if (domainAllowed(recipient, input.allowlistDomains)) {
    return { tier: 'ask', reason: 'allowlist-domain' }
  }
  return { tier: 'never', reason: 'default-deny' }
}

/* ------------------------------------------------------------------ guards */

export interface HopVerdict {
  ok: boolean
  hops: number
  cap: number
}

/** §5.5 — a message at or above the cap is refused; the reply would be cap+1. */
export function checkHops(hops: number, cap: number): HopVerdict {
  const h = Number.isFinite(hops) ? Math.max(0, Math.trunc(hops)) : 0
  const c = Number.isFinite(cap) ? Math.max(0, Math.trunc(cap)) : 0
  return { ok: h < c, hops: h, cap: c }
}

export interface BudgetVerdict {
  ok: boolean
  spentUsd: number
  capUsd: number
  remainingUsd: number
}

/** §6.4 — checked before a session starts and after every tool batch. */
export function checkBudget(spentUsd: number, capUsd: number): BudgetVerdict {
  const spent = Number.isFinite(spentUsd) ? Math.max(0, spentUsd) : 0
  const cap = Number.isFinite(capUsd) ? Math.max(0, capUsd) : 0
  return { ok: spent < cap, spentUsd: spent, capUsd: cap, remainingUsd: Math.max(0, cap - spent) }
}

export interface OutreachBudgetVerdict {
  ok: boolean
  used: number
  limit: number
}

/** §6.3 — per-person weekly outreach budget. Over budget behaves as `skip`. */
export function checkOutreachBudget(used: number, limit: number): OutreachBudgetVerdict {
  const u = Number.isFinite(used) ? Math.max(0, Math.trunc(used)) : 0
  const l = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0
  return { ok: u < l, used: u, limit: l }
}

/** ISO-8601 week key (`2026-W34`) — the bucket for `outreach_budget.week`. */
export function weekKey(at: Date | number = Date.now()): string {
  const d = new Date(at)
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // Thursday of the current ISO week determines the year.
  const day = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(utc.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((utc.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export interface ParticipantVerdict {
  ok: boolean
  count: number
  cap: number
}

/**
 * SPEC §4 — participant cap per thread. A thread that has accumulated a crowd
 * is a CC storm, not a task: every reply then fans out to everyone on it.
 */
export function checkParticipants(count: number, cap: number): ParticipantVerdict {
  const c = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  const k = Number.isFinite(cap) ? Math.max(0, Math.trunc(cap)) : 0
  return { ok: c <= k, count: c, cap: k }
}

/**
 * SPEC §4 — dead-thread TTL. A task nobody has touched for this long is not
 * waiting, it is abandoned: a parked question whose human never answered, or a
 * thread that went quiet. Expiring it closes the loop instead of leaving a
 * session parked forever.
 */
export function isDeadThread(updatedAt: number, ttlDays: number, now = Date.now()): boolean {
  const ttl = Number.isFinite(ttlDays) ? Math.max(0, ttlDays) : 0
  if (ttl === 0) return false
  if (!Number.isFinite(updatedAt)) return false
  return now - updatedAt > ttl * 24 * 60 * 60 * 1000
}

export interface SenderVerdict {
  ok: boolean
  reason:
    | 'allowlisted'
    | 'allowlisted-email'
    | 'roster'
    | 'thread-participant'
    | 'requester'
    | 'not-allowed'
}

/**
 * §5.5 — inbound gate. A sender is accepted when they are the requester, an
 * agent in the roster, on an allowlisted domain, or already a participant of
 * an active task's thread. Everything else is dropped with a log line.
 */
export function checkSender(input: {
  from: string
  requester?: string
  roster?: readonly string[]
  allowlistDomains?: readonly string[]
  allowlistEmails?: readonly string[]
  activeThreadParticipants?: readonly string[]
}): SenderVerdict {
  const from = normalizeAddress(input.from)
  if (from === undefined) return { ok: false, reason: 'not-allowed' }
  if (normalizeAddress(input.requester) === from) return { ok: true, reason: 'requester' }
  if (normalizeAll(input.roster).has(from)) return { ok: true, reason: 'roster' }
  if (normalizeAll(input.allowlistEmails).has(from)) return { ok: true, reason: 'allowlisted-email' }
  if (domainAllowed(from, input.allowlistDomains)) return { ok: true, reason: 'allowlisted' }
  if (normalizeAll(input.activeThreadParticipants).has(from)) {
    return { ok: true, reason: 'thread-participant' }
  }
  return { ok: false, reason: 'not-allowed' }
}
