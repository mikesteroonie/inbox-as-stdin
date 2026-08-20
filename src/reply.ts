/**
 * Reply extraction (§11). All inbound human text passes through `extractReply`
 * before it is rendered into any prompt: take the content above the first quote
 * marker, then trim the signature.
 *
 * Three rules, per the spec:
 *   1. cut at the first attribution line (`On … wrote:`, `-----Original Message-----`)
 *   2. cut at the first run of `>`-quoted lines
 *   3. trim everything after a `-- ` signature delimiter
 *
 * AgentMail already ships a Talon-based `extractedText`; the transport prefers
 * it when present and falls back to this. Keeping our own implementation means
 * the prompt path is never at the mercy of a field that may be absent.
 */

/** Attribution lines that introduce quoted text. Anchored at line start. */
const ATTRIBUTION: RegExp[] = [
  // "On Mon, Aug 17, 2026 at 9:04 AM Ada Lovelace <ada@x.dev> wrote:" —
  // possibly wrapped across two lines by the sending client.
  /^\s*On\b[\s\S]{0,200}?\bwrote:\s*$/,
  /^\s*On\b.{0,200}$/,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*From:\s.+$/,
  /^\s*Sent from my \w+/i,
  /^\s*El\b.{0,200}?escribió:\s*$/i,
  /^\s*Am\b.{0,200}?schrieb\b.{0,80}:\s*$/i,
  /^\s*Le\b.{0,200}?a écrit\s*:\s*$/i,
  /^\s*\S.{0,120}?\bwrote:\s*$/,
]

/**
 * The "On …" opener may wrap. Only treat a bare `On …` line as an attribution
 * when the next non-empty line finishes it with `wrote:` (or the line itself
 * already ends in `wrote:`).
 */
function isAttribution(lines: readonly string[], i: number): boolean {
  const line = lines[i]!
  if (/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/i.test(line)) return true
  if (/^\s*_{5,}\s*$/.test(line)) return true
  if (/^\s*From:\s.+$/.test(line) && /^\s*(Sent|Date|To|Subject):/m.test(lines.slice(i + 1, i + 5).join('\n'))) {
    return true
  }
  if (/wrote:\s*$/.test(line) && /^\s*(On|El|Am|Le|.{0,120}?)\b/.test(line)) return true
  if (/(escribió|schrieb|a écrit)\s*:\s*$/i.test(line)) return true
  if (/^\s*On\b/.test(line)) {
    // Look ahead a couple of lines for the closing `wrote:`.
    const window = lines.slice(i, i + 3).join(' ')
    if (/\bwrote:\s*$/.test(window.trimEnd())) return true
  }
  return false
}

const SIGNATURE_DELIMITER = /^\s*--\s?$/
const APPLE_MAIL_SENT_FROM = /^\s*Sent from my (iPhone|iPad|Mac|Android)\b/i

export interface ExtractOptions {
  /** Skip the signature trim (useful when the caller wants the raw reply). */
  keepSignature?: boolean
}

/** Return only the newly written portion of an email body. */
export function extractReply(body: string | undefined | null, opts: ExtractOptions = {}): string {
  if (typeof body !== 'string' || body.trim() === '') return ''
  const normalized = body.replace(/\r\n/g, '\n').replace(/ /g, ' ')
  const lines = normalized.split('\n')

  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trimStart().startsWith('>')) {
      cut = i
      break
    }
    if (isAttribution(lines, i)) {
      cut = i
      break
    }
    if (APPLE_MAIL_SENT_FROM.test(line)) {
      cut = i
      break
    }
  }

  let kept = lines.slice(0, cut)

  if (!opts.keepSignature) {
    for (let i = 0; i < kept.length; i++) {
      if (SIGNATURE_DELIMITER.test(kept[i]!)) {
        kept = kept.slice(0, i)
        break
      }
    }
  }

  return kept.join('\n').replace(/\s+$/, '').replace(/^\n+/, '')
}

/**
 * Fenced rendering for prompts. Inbound mail is data, never instructions
 * (§7) — every body the model sees is wrapped in this block, and the fence is
 * widened past any backticks in the content so it cannot be broken out of.
 */
export function fenceUntrusted(text: string, label = 'untrusted-email-content'): string {
  const longest = [...text.matchAll(/`{3,}/g)].reduce((max, m) => Math.max(max, m[0].length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${label}\n${text}\n${fence}`
}
