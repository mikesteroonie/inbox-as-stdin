import { describe, expect, it } from 'vitest'
import { UnknownModelError, costOf, costOfUsage, isPriced, priceFor, resolveModelId, validateModels } from '../src/pricing.js'

describe('resolveModelId', () => {
  it.each([
    ['claude-sonnet-4-5', 'claude-sonnet-4-5'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['CLAUDE-SONNET-4-5-latest', 'claude-sonnet-4-5'],
    ['us.anthropic.claude-opus-4-5', 'claude-opus-4-5'],
    ['anthropic.claude-haiku-4-5', 'claude-haiku-4-5'],
    ['claude-sonnet-4-5@20250929', 'claude-sonnet-4-5'],
  ])('%s → %s', (raw, expected) => {
    expect(resolveModelId(raw)).toBe(expected)
  })

  it('passes an empty string through', () => {
    expect(resolveModelId('  ')).toBe('')
  })
})

describe('priceFor', () => {
  it('returns the table entry', () => {
    expect(priceFor('claude-sonnet-4-5').out).toBe(15)
  })

  it('refuses to bill an unknown model at $0 (§11)', () => {
    expect(() => priceFor('gpt-fictional')).toThrow(UnknownModelError)
    expect(isPriced('gpt-fictional')).toBe(false)
  })
})

describe('costOf', () => {
  it('is Σ tokens × table', () => {
    // 1M input + 1M output on sonnet = $3 + $15.
    expect(
      costOf('claude-sonnet-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
    ).toBeCloseTo(18)
  })

  it('prices cache reads and writes separately', () => {
    expect(
      costOf('claude-sonnet-4-5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      }),
    ).toBeCloseTo(4.05)
  })

  it('treats junk counts as zero', () => {
    expect(
      costOf('claude-haiku-4-5', {
        inputTokens: Number.NaN,
        outputTokens: -5,
        cacheReadInputTokens: undefined as unknown as number,
        cacheCreationInputTokens: 0,
      }),
    ).toBe(0)
  })
})

describe('costOfUsage', () => {
  it('sums across models', () => {
    const total = costOfUsage({
      'claude-sonnet-4-5': { inputTokens: 1_000_000 },
      'claude-haiku-4-5': { outputTokens: 1_000_000 },
    })
    expect(total).toBeCloseTo(8)
  })

  it('is zero for nothing', () => {
    expect(costOfUsage(undefined)).toBe(0)
    expect(costOfUsage({})).toBe(0)
  })

  it('throws rather than silently under-billing', () => {
    expect(() => costOfUsage({ 'mystery-model': { inputTokens: 10 } })).toThrow(UnknownModelError)
  })
})

describe('validateModels (doctor startup check)', () => {
  it('passes a known set', () => {
    expect(validateModels(['claude-sonnet-4-5', 'claude-opus-4-5'])).toEqual({ ok: true, unknown: [] })
  })
  it('reports unknown models once each', () => {
    expect(validateModels(['nope', 'nope', '  '])).toEqual({ ok: false, unknown: ['nope'] })
  })
})
