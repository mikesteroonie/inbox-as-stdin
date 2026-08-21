/**
 * Task and question ids. Task ids ride in an email header (§3) and name a
 * worktree directory, so they must be short, lowercase, filesystem-safe and
 * free of characters a mail client might mangle: RFC 4648 base32, lowercased.
 */

import { randomBytes } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** 8 chars of base32 = 40 bits. Collisions are not a concern at pod scale. */
export const TASK_ID_LENGTH = 8

export function base32(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

export function mintTaskId(): string {
  return base32(TASK_ID_LENGTH)
}

export function mintQuestionId(): string {
  return `q_${base32(10)}`
}

const TASK_ID_RE = new RegExp(`^[${ALPHABET}]{${TASK_ID_LENGTH}}$`)

export function isTaskId(value: string): boolean {
  return TASK_ID_RE.test(value)
}

/**
 * AgentMail client ids are restricted to `A-Z a-z 0-9 - . _ ~`. Anything else
 * — a colon, a space, an accent — is rejected with a 400 at create time, so
 * every id we mint gets folded into that set rather than trusting whatever a
 * person typed at the `init` prompt.
 */
export function clientId(prefix: string, name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${prefix}-${safe || 'default'}`
}

const QUESTION_ID_RE = /^q_[a-z2-7]{10}$/

export function isQuestionId(value: string): boolean {
  return QUESTION_ID_RE.test(value)
}
