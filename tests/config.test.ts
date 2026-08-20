import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { ConfigError, apiKeyEnvName, apiKeyFor, budgetsFor, validateConfig } from '../src/config.js'

const minimal = {
  pod: 'swarm',
  requester: 'michael@yourco.dev',
  agents: [{ name: 'backend', inbox: 'backend' }],
}

describe('validateConfig', () => {
  it('accepts a minimal config and fills defaults', () => {
    const cfg = validateConfig(minimal)
    expect(cfg.allowlist.domains).toEqual([])
    expect(cfg.allowlist.emails).toEqual([])
    expect(cfg.envelope).toBe('headers')
    expect(cfg.agents[0]!.repo).toBe('.')
  })

  it('validates the dogfood config, and it reaches exactly one human', () => {
    const cfg = validateConfig(parseYaml(readFileSync('harness.dogfood.yaml', 'utf8')))
    expect(cfg.allowlist.domains).toEqual([])
    expect(cfg.allowlist.emails).toEqual(['michael@agentmail.cc'])
    expect(cfg.requester).toBe('michael@agentmail.cc')
  })

  it('rejects a non-address in the email allowlist', () => {
    expect(() =>
      validateConfig({ ...minimal, allowlist: { emails: ['not-an-address'] } }),
    ).toThrow(ConfigError)
  })

  it('validates the shipped example', () => {
    const cfg = validateConfig(parseYaml(readFileSync('harness.example.yaml', 'utf8')))
    expect(cfg.pod).toBe('swarm-demo')
    expect(cfg.agents.length).toBe(2)
  })

  it('names the yaml path in every error (§0)', () => {
    try {
      validateConfig({ ...minimal, requester: 'not-an-email' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).issues[0]!.path).toBe('requester')
    }
  })

  it('names the path inside an array element', () => {
    try {
      validateConfig({ ...minimal, agents: [{ name: 'Backend!', inbox: 'x' }] })
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as ConfigError).issues[0]!.path).toBe('agents[0].name')
    }
  })

  it('rejects unknown keys rather than ignoring a typo', () => {
    expect(() => validateConfig({ ...minimal, budgetz: {} })).toThrow(ConfigError)
  })

  it('rejects duplicate agent names and inboxes', () => {
    expect(() =>
      validateConfig({
        ...minimal,
        agents: [
          { name: 'a', inbox: 'x' },
          { name: 'a', inbox: 'y' },
        ],
      }),
    ).toThrow(/duplicate agent name/)
    expect(() =>
      validateConfig({
        ...minimal,
        agents: [
          { name: 'a', inbox: 'X' },
          { name: 'b', inbox: 'x' },
        ],
      }),
    ).toThrow(/duplicate inbox/)
  })

  it('requires at least one agent', () => {
    expect(() => validateConfig({ ...minimal, agents: [] })).toThrow(ConfigError)
  })
})

describe('budgetsFor (§6.4)', () => {
  it('uses the pinned defaults when nothing is set', () => {
    expect(budgetsFor(validateConfig(minimal))).toEqual({
      usd: 5,
      maxHops: 6,
      questionsPerPersonWeek: 3,
      maxConcurrent: 3,
      maxParticipants: 10,
      deadThreadTtlDays: 14,
    })
  })

  it('lets an agent override field by field', () => {
    const cfg = validateConfig({
      ...minimal,
      budgets: { usd: 5, max_hops: 6 },
      agents: [{ name: 'backend', inbox: 'backend', budgets: { usd: 10 } }],
    })
    const budgets = budgetsFor(cfg, cfg.agents[0])
    expect(budgets.usd).toBe(10)
    expect(budgets.maxHops).toBe(6)
  })
})

describe('api keys never live in yaml (§9)', () => {
  it('derives the env var name from the agent name', () => {
    expect(apiKeyEnvName('backend')).toBe('AGENTMAIL_API_KEY_BACKEND')
    expect(apiKeyEnvName('code-review')).toBe('AGENTMAIL_API_KEY_CODE_REVIEW')
  })

  it('prefers the per-inbox key and falls back to the org key', () => {
    expect(apiKeyFor('backend', { AGENTMAIL_API_KEY_BACKEND: 'a', AGENTMAIL_API_KEY: 'b' })).toBe('a')
    expect(apiKeyFor('backend', { AGENTMAIL_API_KEY: 'b' })).toBe('b')
    expect(apiKeyFor('backend', {})).toBeUndefined()
  })
})
