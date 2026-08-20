#!/usr/bin/env node
/**
 * `harness` (§9): init | up | send | tail | doctor.
 */

import { existsSync } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Command } from 'commander'
import { stringify as toYaml } from 'yaml'
import { apiKeyEnvName, apiKeyFor, budgetsFor, loadConfig, ConfigError, type HarnessConfig } from './config.js'
import { Daemon } from './daemon.js'
import { agentForInbox, inboxOf } from './dispatch.js'
import * as envelope from './envelope.js'
import { logger } from './log.js'
import { PRICES, RECOMMENDED_MODEL, validateModels } from './pricing.js'
import { Store } from './store.js'
import { AgentMailTransport } from './transport/agentmail.js'
import type { MailTransport } from './transport/types.js'
import { ANSWERS_PATH, DECISIONS_PATH, syncDecisions } from './harness/answers.js'

const log = logger('cli')

const program = new Command()
program
  .name('harness')
  .description('Email as the interface to a pod of coding agents. The inbox is stdin.')
  .version('0.1.0')

/* ----------------------------------------------------------------- init */

program
  .command('init')
  .description('create the pod: inboxes, per-inbox API keys, harness.yaml, .env, .harness/')
  .option('-c, --config <path>', 'config path to write', 'harness.yaml')
  .option('--pod <name>', 'pod name')
  .option('--requester <email>', 'default CC and permission-gate recipient')
  .option('--agents <names>', 'comma-separated agent names')
  .option('--domain <domain>', 'inbox domain (defaults to the AgentMail org default)')
  .action(async (opts) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ask = async (q: string, fallback = ''): Promise<string> => {
      const answer = (await rl.question(fallback ? `${q} [${fallback}] ` : `${q} `)).trim()
      return answer || fallback
    }

    try {
      if (existsSync(opts.config)) {
        console.error(`${opts.config} already exists. Move it aside first.`)
        process.exitCode = 1
        return
      }
      const orgKey = process.env.AGENTMAIL_API_KEY
      if (!orgKey) {
        console.error('AGENTMAIL_API_KEY is not set. Get an org key from the AgentMail dashboard.')
        process.exitCode = 1
        return
      }

      const pod = opts.pod ?? (await ask('Pod name?', 'swarm'))
      const requester = opts.requester ?? (await ask('Your email (permission gate + default CC)?'))
      if (!requester.includes('@')) {
        console.error('A requester email is required — the permission gate has to reach someone.')
        process.exitCode = 1
        return
      }
      const agentNames = (opts.agents ?? (await ask('Agent names, comma-separated?', 'backend')))
        .split(',')
        .map((s: string) => s.trim().toLowerCase())
        .filter(Boolean)
      const domains = (await ask('Allowlisted domains for tier-ask outreach, comma-separated?', requester.split('@')[1] ?? ''))
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)

      const transport = new AgentMailTransport({
        apiKey: orgKey,
        ...(opts.domain ? { domain: opts.domain } : {}),
      })

      const podId = await ensurePod(transport, pod)
      const envLines: string[] = []
      const agents: HarnessConfig['agents'] = []

      for (const name of agentNames) {
        const display = await ask(`Display name for "${name}"?`, `${title(name)} Agent`)
        const repo = await ask(`Repo for "${name}" (path or git URL)?`, '.')
        const { inboxId, email } = await transport.ensureInbox(name, display)
        console.log(`  inbox ready: ${email}`)
        const key = await mintKey(transport, inboxId, name)
        if (key) envLines.push(`${apiKeyEnvName(name)}=${key}`)
        agents.push({
          name,
          inbox: email,
          display_name: display,
          repo,
          tools: ['read', 'write', 'bash', 'send_email_to_agent', 'ask_code_author'],
          model: RECOMMENDED_MODEL,
        })
      }

      const cfg: Record<string, unknown> = {
        pod,
        ...(podId ? { pod_id: podId } : {}),
        allowlist: { domains },
        requester,
        budgets: { usd: 5, max_hops: 6, questions_per_person_week: 3, max_concurrent: 3 },
        envelope: 'headers',
        agents,
      }
      await writeFile(opts.config, header() + toYaml(cfg), 'utf8')
      if (envLines.length > 0) {
        await appendFile('.env', (existsSync('.env') ? '\n' : '') + envLines.join('\n') + '\n', 'utf8')
      }
      new Store('.harness/journal.db').close()

      console.log(`\nWrote ${opts.config} and ${envLines.length} key(s) to .env (keys never go in yaml).`)
      console.log('Next: `harness doctor` to verify the round-trip, then `harness up`.')
    } finally {
      rl.close()
    }
  })

function header(): string {
  return [
    '# Written by `harness init`. See IMPLEMENTATION.md §9 for the schema.',
    '# API keys live in .env, never here.',
    '',
  ].join('\n')
}

function title(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

async function ensurePod(transport: AgentMailTransport, name: string): Promise<string | undefined> {
  try {
    const pods = await transport.raw.pods.list()
    const existing = pods.pods.find((p) => p.name === name)
    if (existing) return existing.podId
    const created = await transport.raw.pods.create({ name, clientId: `harness:${name}` })
    return created.podId
  } catch (err) {
    log.warn('could not create a pod; continuing without pod scoping', { err: String(err) })
    return undefined
  }
}

async function mintKey(
  transport: AgentMailTransport,
  inboxId: string,
  name: string,
): Promise<string | undefined> {
  try {
    const key = await transport.raw.inboxes.apiKeys.create(inboxId, { name: `harness-${name}` })
    return key.apiKey
  } catch (err) {
    log.warn('could not mint a per-inbox key; the org key will be used', { agent: name, err: String(err) })
    return undefined
  }
}

/* ------------------------------------------------------------------- up */

program
  .command('up')
  .description('run the daemon')
  .option('-c, --config <path>', 'config path', 'harness.yaml')
  .option('--once', 'process the backlog and exit (CI/testing mode)')
  .action(async (opts) => {
    const cfg = load(opts.config)
    const models = cfg.agents.map((a) => a.model).filter((m): m is string => !!m)
    const check = validateModels(models)
    if (!check.ok) {
      console.error(`Unpriced model(s): ${check.unknown.join(', ')}. Add them to src/pricing.ts.`)
      process.exitCode = 1
      return
    }

    const store = new Store('.harness/journal.db')
    const transports = buildTransports(cfg)
    // §8: `harness up` renders the pod-level ledger from the jsonl on change.
    await syncDecisions(ANSWERS_PATH, DECISIONS_PATH).catch(() => undefined)

    const daemon = new Daemon({ cfg, store, transports })

    if (opts.once) {
      const results = await daemon.runOnce()
      const counts = new Map<string, number>()
      for (const r of results) counts.set(r.disposition, (counts.get(r.disposition) ?? 0) + 1)
      console.log(
        results.length === 0
          ? 'Backlog empty.'
          : [...counts].map(([k, v]) => `${k}: ${v}`).join(', '),
      )
      store.close()
      return
    }

    const shutdown = (): void => {
      console.log('\nStopping…')
      daemon.stop()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    const budgets = budgetsFor(cfg)
    console.log(
      `harness up — pod ${cfg.pod}, ${cfg.agents.length} agent(s), ` +
        `$${budgets.usd}/task, ${budgets.maxConcurrent} concurrent. Ctrl-C to stop.`,
    )
    await daemon.run()
    store.close()
  })

/* ----------------------------------------------------------------- send */

program
  .command('send')
  .description('inject a task without a mail client')
  .argument('<text>', 'the task')
  .requiredOption('--to <agent>', 'agent name or inbox address')
  .option('-c, --config <path>', 'config path', 'harness.yaml')
  .option('--subject <subject>', 'subject line')
  .option('--thread <id>', 'reply on an existing thread instead of starting one')
  .action(async (text: string, opts) => {
    const cfg = load(opts.config)
    const agent = cfg.agents.find((a) => a.name === opts.to) ?? agentForInbox(cfg, opts.to)
    if (!agent) {
      console.error(`No agent "${opts.to}". Known: ${cfg.agents.map((a) => a.name).join(', ')}`)
      process.exitCode = 1
      return
    }
    const transport = transportFor(cfg, agent.name)
    const subject = opts.subject ?? firstLine(text)

    if (opts.thread) {
      const thread = await transport.getThread(inboxOf(agent), opts.thread)
      const last = thread.messages[thread.messages.length - 1]
      if (!last) {
        console.error(`Thread ${opts.thread} has no messages.`)
        process.exitCode = 1
        return
      }
      const { headers, text: body } = envelope.encode({ hops: 0 }, text, cfg.envelope)
      await transport.reply(inboxOf(agent), last.messageId, { text: body, headers, to: [inboxOf(agent)] })
      console.log(`Replied on thread ${opts.thread}.`)
      return
    }

    // A task injected from the CLI is human input: no proto header, so the
    // pipeline treats it exactly like mail from the requester (§3).
    const res = await transport.send(inboxOf(agent), {
      to: [inboxOf(agent)],
      subject,
      text,
    })
    console.log(`Sent to ${inboxOf(agent)} — thread ${res.threadId}.`)
  })

function firstLine(text: string): string {
  return text.split('\n')[0]!.slice(0, 78) || 'Task'
}

/* ----------------------------------------------------------------- tail */

program
  .command('tail')
  .description('render a thread as a conversation')
  .argument('[thread_id]', 'thread to render; omitted lists recent tasks')
  .option('-c, --config <path>', 'config path', 'harness.yaml')
  .action(async (threadId: string | undefined, opts) => {
    const cfg = load(opts.config)
    const store = new Store('.harness/journal.db')

    if (!threadId) {
      const tasks = store.listTasks().slice(0, 20)
      if (tasks.length === 0) console.log('No tasks yet.')
      for (const t of tasks) {
        console.log(
          `${t.task_id}  ${t.state.padEnd(14)} ${t.agent.padEnd(10)} ` +
            `$${t.spent_usd.toFixed(2).padStart(6)}  hops ${t.hops}  ${t.thread_id ?? '-'}`,
        )
      }
      store.close()
      return
    }

    const task = store.getLatestTaskByThread(threadId)
    const agent = cfg.agents.find((a) => a.name === task?.agent) ?? cfg.agents[0]!
    const transport = transportFor(cfg, agent.name)
    const thread = await transport.getThread(inboxOf(agent), threadId)

    console.log(`# ${thread.subject ?? '(no subject)'}`)
    console.log(`${thread.messages.length} messages · labels: ${thread.labels.join(', ') || 'none'}\n`)
    for (const m of thread.messages) {
      const when = new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 16)
      const hops = m.headers['x-hops']
      console.log(`── ${m.from} · ${when}${hops ? ` · hop ${hops}` : ''}`)
      console.log(indent(m.extractedText || m.text))
      if (m.attachments.length) {
        console.log(`   [${m.attachments.map((a) => a.filename ?? 'attachment').join(', ')}]`)
      }
      console.log()
    }
    if (task) {
      console.log(`task ${task.task_id} · ${task.state} · $${task.spent_usd.toFixed(2)} · hops ${task.hops}`)
      const questions = store.listQuestions(task.task_id)
      for (const q of questions) {
        console.log(`  ? ${q.question_id} ${q.state} → ${q.asked_email}: ${q.question.slice(0, 60)}`)
      }
    }
    store.close()
  })

function indent(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `   ${l}`)
    .join('\n')
}

/* ------------------------------------------------------------------ mcp */

program
  .command('mcp')
  .description('serve send_email_to_agent over MCP (stdio) — join a swarm without the daemon')
  .requiredOption('--agent <name>', 'which agent inbox to send from')
  .option('-c, --config <path>', 'config path', 'harness.yaml')
  .action(async (opts) => {
    const cfg = load(opts.config)
    const agent = cfg.agents.find((a) => a.name === opts.agent) ?? agentForInbox(cfg, opts.agent)
    if (!agent) {
      console.error(`No agent "${opts.agent}". Known: ${cfg.agents.map((a) => a.name).join(', ')}`)
      process.exitCode = 1
      return
    }
    // stdout is the MCP transport from here on — logs must not land in it.
    process.env.HARNESS_LOG_LEVEL = 'error'
    process.env.HARNESS_LOG_STDERR = '1'
    const { serveStdio } = await import('./mcp.js')
    await serveStdio({ cfg, agent, transport: transportFor(cfg, agent.name) })
  })

/* --------------------------------------------------------------- doctor */

program
  .command('doctor')
  .description('check keys, inboxes, websocket, pricing, and the §3 envelope round-trip')
  .option('-c, --config <path>', 'config path', 'harness.yaml')
  .option('--skip-roundtrip', 'skip the probe email (no mail is sent)')
  .action(async (opts) => {
    let failures = 0
    const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
      try {
        const detail = await fn()
        console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
      } catch (err) {
        failures++
        console.log(`  FAIL ${name} — ${describeError(err)}`)
      }
    }

    let cfg: HarnessConfig
    try {
      cfg = load(opts.config)
      console.log(`  ok   config — pod ${cfg.pod}, ${cfg.agents.length} agent(s)`)
    } catch (err) {
      console.log(`  FAIL config — ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
      return
    }

    await check('pricing table', async () => {
      const models = cfg.agents.map((a) => a.model).filter((m): m is string => !!m)
      const result = validateModels(models)
      if (!result.ok) throw new Error(`unpriced model(s): ${result.unknown.join(', ')}`)
      // An agent with no pinned model inherits whatever the Agent SDK defaults
      // to, which this table may not know — and a model we cannot price stops
      // the task at its first turn. Say so here rather than at 2am.
      const unpinned = cfg.agents.filter((a) => !a.model).map((a) => a.name)
      if (unpinned.length > 0) {
        throw new Error(
          `no model pinned for ${unpinned.join(', ')} — the budget guard can only be ` +
            `verified against a pinned, priced model. Add \`model: ${RECOMMENDED_MODEL}\` ` +
            `to each agent in ${opts.config}.`,
        )
      }
      return `${Object.keys(PRICES).length} models priced`
    })

    for (const agent of cfg.agents) {
      await check(`api key (${agent.name})`, async () => {
        const key = apiKeyFor(agent.name)
        if (!key) throw new Error(`set ${apiKeyEnvName(agent.name)} or AGENTMAIL_API_KEY in .env`)
        return `${key.slice(0, 6)}…`
      })
      await check(`inbox (${agent.name})`, async () => {
        const transport = transportFor(cfg, agent.name)
        const thread = await transport.listSince(inboxOf(agent), 0, 1)
        return `${inboxOf(agent)} reachable (${thread.length} recent)`
      })
    }

    await check('websocket', async () => {
      const first = cfg.agents[0]!
      const transport = transportFor(cfg, first.name)
      const sub = await transport.listen(
        { ...(cfg.pod_id ? { podId: cfg.pod_id } : {}), inboxIds: [inboxOf(first)] },
        () => undefined,
      )
      sub.stop()
      return 'connected and subscribed'
    })

    if (!opts.skipRoundtrip) {
      // Q1 (§3): does the receive path preserve custom headers end-to-end?
      // This is that test, automated.
      await check('envelope round-trip (Q1)', async () => roundTrip(cfg))
    }

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
    if (failures > 0) process.exitCode = 1
  })

/**
 * Send a probe to our own inbox and read the headers back off it. Proves §3
 * works on this deployment — or tells you to switch `envelope: trailer`.
 */
async function roundTrip(cfg: HarnessConfig): Promise<string> {
  const agent = cfg.agents[0]!
  const transport = transportFor(cfg, agent.name)
  const inbox = inboxOf(agent)
  const probeTask = 'aaaaaaaa'
  const { headers, text } = envelope.encode({ taskId: probeTask, hops: 1 }, 'harness doctor probe.', cfg.envelope)

  const sent = await transport.send(inbox, {
    to: [inbox],
    subject: 'harness doctor: envelope probe',
    text,
    headers,
  })

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000))
    const refs = await transport.listSince(inbox, Date.now() - 300_000, 25)
    for (const ref of refs) {
      if (ref.messageId === sent.messageId) continue
      const message = await transport.getMessage(inbox, ref.messageId)
      if (message.subject !== 'harness doctor: envelope probe') continue
      const parsed = envelope.parse(message.headers, message.text)
      if (parsed.taskId === probeTask && parsed.hops === 1 && !parsed.human) {
        return `headers survived (${cfg.envelope} mode)`
      }
      throw new Error(
        `probe arrived but the envelope did not survive (task=${parsed.taskId ?? 'lost'}, ` +
          `hops=${parsed.hops}). Set \`envelope: trailer\` in ${'harness.yaml'} and re-run.`,
      )
    }
  }
  throw new Error('probe never arrived within 60s')
}

/* -------------------------------------------------------------- helpers */

/**
 * One readable line out of anything a client can throw.
 *
 * The checklist is the diagnostic, so a failure that renders as
 * `[object Object]` or spills a multi-line body across the other rows costs
 * exactly the information the command exists to give. SDK errors carry their
 * detail on `body` rather than `message`, and a websocket can reject with a
 * plain object that is not an Error at all.
 */
export function describeError(err: unknown): string {
  const line = collapse(messageOf(err))
  // A blocked host is the one failure people misread as a broken key.
  const hint = /not in allowlist|CONNECT tunnel failed|ENOTFOUND|EAI_AGAIN/i.test(line)
    ? ' (network egress is blocking the host, not the API key)'
    : ''
  return (line.length > 240 ? `${line.slice(0, 240)}…` : line) + hint
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return String(err)
  if (typeof err !== 'object') return String(err)

  const record = err as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message.trim() : ''
  const body =
    typeof record.body === 'string'
      ? record.body.trim()
      : record.body && typeof record.body === 'object'
        ? JSON.stringify(record.body)
        : ''

  // SDK errors put the useful half on `body` and a bare status on `message`,
  // but sometimes `message` already quotes the body — do not say it twice.
  if (message && body) {
    return collapse(message).includes(collapse(body)) ? message : `${message}: ${body}`
  }
  if (message || body) return message || body

  // Not an Error at all: websocket rejections can be plain event-ish objects
  // with nothing on `message`. Pull whatever identifies them.
  const parts = ['reason', 'code', 'type', 'name', 'statusCode', 'status', 'error']
    .map((key) => (record[key] === undefined ? '' : `${key}=${stringifyShallow(record[key])}`))
    .filter(Boolean)
  if (parts.length > 0) return parts.join(' ')

  const keys = Object.keys(record)
  if (keys.length > 0) return JSON.stringify(record)
  return err instanceof Error ? `${err.name} (no message)` : 'unknown error (no message, no fields)'
}

function stringifyShallow(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return String(value)
  const nested = (value as Record<string, unknown>).message
  return typeof nested === 'string' ? nested : JSON.stringify(value)
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function load(path: string): HarnessConfig {
  try {
    return loadConfig(path)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}

function transportFor(cfg: HarnessConfig, agentName: string): MailTransport {
  const key = apiKeyFor(agentName)
  if (!key) {
    console.error(`No API key for "${agentName}". Set ${apiKeyEnvName(agentName)} in .env.`)
    process.exit(1)
  }
  return new AgentMailTransport({
    apiKey: key,
    ...(cfg.pod_id ? { podId: cfg.pod_id } : {}),
  })
}

function buildTransports(cfg: HarnessConfig): Map<string, MailTransport> {
  const map = new Map<string, MailTransport>()
  for (const agent of cfg.agents) map.set(agent.name, transportFor(cfg, agent.name))
  return map
}

/* ----------------------------------------------------------------- main */

async function main(): Promise<void> {
  await loadDotEnv()
  await program.parseAsync(process.argv)
}

/** Minimal .env reader — one dependency fewer, and the format is trivial. */
async function loadDotEnv(path = '.env'): Promise<void> {
  if (!existsSync(path)) return
  const text = await readFile(path, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (process.env[key] === undefined) process.env[key] = value
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
