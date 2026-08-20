/**
 * harness.yaml — parsed with `yaml`, validated with Zod (§9). Config is
 * validated on load and every error names the yaml path that caused it.
 */

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'

const Budgets = z
  .object({
    usd: z.number().positive().optional(),
    max_hops: z.number().int().positive().optional(),
    questions_per_person_week: z.number().int().nonnegative().optional(),
    max_concurrent: z.number().int().positive().optional(),
    /** SPEC §4 — participant cap per thread. */
    max_participants: z.number().int().positive().optional(),
    /** SPEC §4 — dead-thread TTL, in days. */
    dead_thread_ttl_days: z.number().int().positive().optional(),
  })
  .strict()

const Agent = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase alphanumeric with dashes'),
    /** Local part of the inbox address; the domain comes from the AgentMail org. */
    inbox: z.string().min(1),
    display_name: z.string().min(1).optional(),
    /** Path or git URL the agent works in. */
    repo: z.string().min(1).default('.'),
    /** Extra system prompt appended to prompts/system.md. */
    prompt: z.string().optional(),
    tools: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    budgets: Budgets.optional(),
  })
  .strict()

export const HarnessConfigSchema = z
  .object({
    pod: z.string().min(1),
    /** AgentMail pod id, written by `harness init`. Falls back to `pod`. */
    pod_id: z.string().min(1).optional(),
    allowlist: z
      .object({ domains: z.array(z.string().min(1)).default([]) })
      .strict()
      .default({ domains: [] }),
    /** Default CC and permission-gate recipient (§6.2). */
    requester: z.string().email(),
    budgets: Budgets.default({}),
    /** How outbound mail carries the envelope (§3 / Q1). */
    envelope: z.enum(['headers', 'trailer', 'both']).default('headers'),
    /**
     * SPEC §4.6 / IMPLEMENTATION §11 — the patch always ships; a PR is a
     * courtesy opened when `gh` is available. `never` turns that off for
     * repos where an agent should not be pushing branches.
     */
    pr: z.enum(['auto', 'never']).default('auto'),
    agents: z.array(Agent).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const names = new Set<string>()
    const inboxes = new Set<string>()
    cfg.agents.forEach((agent, i) => {
      if (names.has(agent.name)) {
        ctx.addIssue({ code: 'custom', path: ['agents', i, 'name'], message: `duplicate agent name "${agent.name}"` })
      }
      names.add(agent.name)
      const inbox = agent.inbox.toLowerCase()
      if (inboxes.has(inbox)) {
        ctx.addIssue({ code: 'custom', path: ['agents', i, 'inbox'], message: `duplicate inbox "${agent.inbox}"` })
      }
      inboxes.add(inbox)
    })
  })

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>
export type AgentConfig = HarnessConfig['agents'][number]

export const DEFAULTS = {
  usd: 5,
  maxHops: 6,
  questionsPerPersonWeek: 3,
  maxConcurrent: 3,
  /**
   * SPEC §4 names these two guards but not their numbers. Ten participants is
   * a large but plausible thread; past that it is a CC storm, not a task.
   * Fourteen days is longer than a holiday, which is the usual reason a parked
   * question goes unanswered.
   */
  maxParticipants: 10,
  deadThreadTtlDays: 14,
} as const

export interface ResolvedBudgets {
  usd: number
  maxHops: number
  questionsPerPersonWeek: number
  maxConcurrent: number
  maxParticipants: number
  deadThreadTtlDays: number
}

/** Per-agent budgets override the pod defaults, field by field (§6.4). */
export function budgetsFor(cfg: HarnessConfig, agent?: AgentConfig): ResolvedBudgets {
  const pod = cfg.budgets ?? {}
  const own = agent?.budgets ?? {}
  return {
    usd: own.usd ?? pod.usd ?? DEFAULTS.usd,
    maxHops: own.max_hops ?? pod.max_hops ?? DEFAULTS.maxHops,
    questionsPerPersonWeek:
      own.questions_per_person_week ?? pod.questions_per_person_week ?? DEFAULTS.questionsPerPersonWeek,
    maxConcurrent: own.max_concurrent ?? pod.max_concurrent ?? DEFAULTS.maxConcurrent,
    maxParticipants: own.max_participants ?? pod.max_participants ?? DEFAULTS.maxParticipants,
    deadThreadTtlDays:
      own.dead_thread_ttl_days ?? pod.dead_thread_ttl_days ?? DEFAULTS.deadThreadTtlDays,
  }
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly { path: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

function yamlPath(path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return '(root)'
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : String(p)))
    .join('.')
    .replace(/\.\[/g, '[')
}

/** Validate an already-parsed object. Errors name the offending yaml path. */
export function validateConfig(raw: unknown, source = 'harness.yaml'): HarnessConfig {
  const result = HarnessConfigSchema.safeParse(raw)
  if (result.success) return result.data
  const issues = result.error.issues.map((i) => ({ path: yamlPath(i.path), message: i.message }))
  const detail = issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')
  throw new ConfigError(`${source} is invalid:\n${detail}`, issues)
}

export function loadConfig(path = 'harness.yaml'): HarnessConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ConfigError(`Cannot read ${path}. Run \`harness init\` first.`)
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${(err as Error).message}`)
  }
  return validateConfig(raw, path)
}

/** Env var holding an agent's per-inbox API key: AGENTMAIL_API_KEY_<AGENT>. */
export function apiKeyEnvName(agentName: string): string {
  return `AGENTMAIL_API_KEY_${agentName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/** Per-inbox key if present, else the org key. Keys never live in yaml (§9). */
export function apiKeyFor(agentName: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[apiKeyEnvName(agentName)] ?? env.AGENTMAIL_API_KEY
}
