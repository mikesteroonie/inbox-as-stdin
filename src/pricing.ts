/**
 * Cost accounting (§11). A static USD-per-million-token table for the models
 * the harness invokes, validated at startup: an unknown model id fails
 * `doctor` rather than silently costing $0.
 *
 * Spend = Σ tokens × table. The Agent SDK also reports its own `costUSD`; we
 * keep our own number because the budget guard must not depend on a field we
 * do not control, and because a model we have never priced should be loud.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  in: number
  /** USD per million output tokens. */
  out: number
  /** USD per million cache-read input tokens. */
  cacheRead: number
  /** USD per million cache-write (5m TTL) input tokens. */
  cacheWrite: number
}

/**
 * Prices are per million tokens, first-party Anthropic API rates. Keys are
 * canonical model ids; aliases are resolved by `resolveModelId` before lookup.
 * Cache rates follow the published multipliers: a read is 0.1x the input rate,
 * a 5-minute-TTL write is 1.25x.
 *
 * Update deliberately — a wrong number here is a wrong budget everywhere.
 * Intro pricing is deliberately NOT used (Sonnet 5 is $2/$10 through
 * 2026-08-31): over-estimating parks a task early, under-estimating overspends,
 * and only one of those is a safe way to be wrong.
 *
 * Bedrock and Vertex are partner-operated with their own rates; a deployment on
 * either should replace these numbers.
 */
export const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-mythos-5': { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

/**
 * What an agent runs on when `harness.yaml` pins no model. Pinning is strongly
 * preferred: an unpinned agent inherits whatever the Agent SDK defaults to, and
 * a model this table has never heard of stops the task rather than being
 * charged at $0 (see `session.ts`).
 */
export const RECOMMENDED_MODEL = 'claude-opus-5'

/** Alias → canonical id. Covers dated ids and the `-latest` style aliases. */
export function resolveModelId(model: string): string {
  const m = model.trim().toLowerCase()
  if (m === '') return m
  // Strip provider prefixes (bedrock/vertex style) and any trailing date/version.
  const bare = m.replace(/^(?:us|eu|apac)\.(?:anthropic\.)?/, '').replace(/^anthropic\./, '')
  const undated = bare.replace(/-(?:\d{8}|latest|v\d+(?::\d+)?)$/, '')
  if (undated in PRICES) return undated
  // `claude-3-5-sonnet` style ordering, and `claude-sonnet-4-5@20250929`.
  const at = undated.split('@')[0]!
  return at
}

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export class UnknownModelError extends Error {
  constructor(public readonly model: string) {
    super(
      `No price for model "${model}". Add it to src/pricing.ts — the harness ` +
        `refuses to bill an unknown model at $0.`,
    )
    this.name = 'UnknownModelError'
  }
}

export function priceFor(model: string): ModelPrice {
  const price = PRICES[resolveModelId(model)]
  if (price === undefined) throw new UnknownModelError(model)
  return price
}

export function isPriced(model: string): boolean {
  return PRICES[resolveModelId(model)] !== undefined
}

const PER_MTOK = 1_000_000

export function costOf(model: string, tokens: TokenCounts): number {
  const p = priceFor(model)
  return (
    (num(tokens.inputTokens) * p.in +
      num(tokens.outputTokens) * p.out +
      num(tokens.cacheReadInputTokens) * p.cacheRead +
      num(tokens.cacheCreationInputTokens) * p.cacheWrite) /
    PER_MTOK
  )
}

/** Sum an Agent SDK `modelUsage` map. Throws on the first unpriced model. */
export function costOfUsage(usage: Record<string, Partial<TokenCounts>> | undefined): number {
  let total = 0
  for (const [model, counts] of Object.entries(usage ?? {})) {
    total += costOf(model, {
      inputTokens: num(counts.inputTokens),
      outputTokens: num(counts.outputTokens),
      cacheReadInputTokens: num(counts.cacheReadInputTokens),
      cacheCreationInputTokens: num(counts.cacheCreationInputTokens),
    })
  }
  return total
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** Startup check used by `doctor` and by `up` before any session runs. */
export function validateModels(models: readonly string[]): { ok: boolean; unknown: string[] } {
  const unknown = [...new Set(models.filter((m) => m.trim() !== '' && !isPriced(m)))]
  return { ok: unknown.length === 0, unknown }
}
