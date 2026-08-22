/**
 * `harness` (§9): init | up | send | tail | doctor.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { confirm, input, select } from '@inquirer/prompts'
import { Command } from 'commander'
import { stringify as toYaml } from 'yaml'
import { apiKeyEnvName, apiKeyFor, budgetsFor, loadConfig, ConfigError, type HarnessConfig } from './config.js'
import { clientId, mintTaskId } from './ids.js'
import { Daemon } from './daemon.js'
import { agentForInbox, inboxOf } from './dispatch.js'
import * as envelope from './envelope.js'
import { logger } from './log.js'
import { PRICES, RECOMMENDED_MODEL, validateModels } from './pricing.js'
import { Store } from './store.js'
import { AgentMailTransport } from './transport/agentmail.js'
import { InboxTakenError, type MailTransport } from './transport/types.js'
import { ANSWERS_PATH, DECISIONS_PATH, syncDecisions } from './harness/answers.js'
import { removeWorktree } from './harness/worktree.js'

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
  .option('-y, --yes', 'accept every default without prompting (scripts, CI)')
  .action(async (opts) => {
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

      const auto = Boolean(opts.yes)
      console.log(`\n${bold('harness init')} — creating a pod of agents that work over email.\n`)

      const pod = opts.pod ?? (await ask({ message: 'Pod name', default: 'swarm', auto }))
      const requester =
        opts.requester ??
        (await ask({
          message: 'Your email (permission gate + default CC)',
          auto,
          validate: (v) => (v.includes('@') ? true : 'The permission gate has to reach a real address.'),
        }))
      if (!requester.includes('@')) {
        console.error('--yes needs --requester: there is no sensible default for your address.')
        process.exitCode = 1
        return
      }

      const agentNames = normalizeAgentNames(
        opts.agents ??
          (await ask({
            message: 'Agent names, comma-separated',
            default: 'backend',
            auto,
            validate: (v) =>
              normalizeAgentNames(v).length > 0 ? true : 'Give at least one name, e.g. backend, frontend.',
          })),
      )

      const scope = auto
        ? 'person'
        : await select({
            message: 'Who may the agents email for help?',
            choices: [
              {
                name: `Only me (${requester})`,
                value: 'person',
                description: 'Nobody else is reachable. The safest place to start.',
              },
              {
                name: `Anyone at ${requester.split('@')[1]}`,
                value: 'domain',
                description: 'Every colleague becomes reachable, each still behind your yes/no gate.',
              },
              { name: 'Nobody yet — I will edit the config later', value: 'none', description: '' },
            ],
          })

      const transport = new AgentMailTransport({
        apiKey: orgKey,
        ...(opts.domain ? { domain: opts.domain } : {}),
      })

      console.log('')
      const podId = await ensurePod(transport, pod)
      const envLines: string[] = []
      const agents: HarnessConfig['agents'] = []

      for (const name of agentNames) {
        const display = await ask({
          message: `Display name for "${name}"`,
          default: `${title(name)} Agent`,
          auto,
        })
        const repo = await askRepo(name, auto)

        const inbox = await claimInbox(transport, name, display, auto)
        if (!inbox) {
          console.error(
            `\nNothing was written. Re-run \`harness init\` when you have a name to use — ` +
              `inbox creation is idempotent, so anything already created will be reused.`,
          )
          process.exitCode = 1
          return
        }
        console.log(`  ${tick} inbox  ${inbox.email}`)

        const key = await mintKey(transport, inbox.inboxId, name)
        if (key) {
          envLines.push(`${apiKeyEnvName(name)}=${key}`)
          console.log(`  ${tick} key    ${apiKeyEnvName(name)}`)
        }
        agents.push({
          name,
          inbox: inbox.email,
          display_name: display,
          repo,
          tools: ['read', 'write', 'bash', 'send_email_to_agent', 'ask_code_author'],
          model: RECOMMENDED_MODEL,
        })
      }

      const allowlist =
        scope === 'person'
          ? { domains: [], emails: [requester] }
          : scope === 'domain'
            ? { domains: [requester.split('@')[1] ?? ''], emails: [] }
            : { domains: [], emails: [] }

      const cfg: Record<string, unknown> = {
        pod,
        ...(podId ? { pod_id: podId } : {}),
        allowlist,
        requester,
        budgets: { usd: 5, max_hops: 6, questions_per_person_week: 3, max_concurrent: 3 },
        envelope: 'headers',
        pr: 'auto',
        agents,
      }
      await writeFile(opts.config, header() + toYaml(cfg), 'utf8')
      console.log(`  ${tick} config ${opts.config}`)
      if (envLines.length > 0) {
        await appendFile('.env', (existsSync('.env') ? '\n' : '') + envLines.join('\n') + '\n', 'utf8')
        console.log(`  ${tick} keys   ${envLines.length} written to .env`)
      }
      new Store('.harness/journal.db').close()

      console.log(`\n${bold(`Pod "${pod}" is ready.`)}`)
      for (const a of agents) console.log(`  ${a.display_name ?? a.name}  ${a.inbox}`)
      console.log(
        scope === 'domain'
          ? `\nOutreach: anyone at ${requester.split('@')[1]}, each ask gated by your yes/no reply.`
          : scope === 'person'
            ? `\nOutreach: only ${requester}. Nobody else is reachable.`
            : `\nOutreach: nobody yet — add addresses to \`allowlist.emails\` in ${opts.config}.`,
      )
      console.log('\nNext: `harness doctor`, then `harness up`.')
    } catch (err) {
      if (isCancel(err)) {
        console.log('\nCancelled. Nothing was written.')
        return
      }
      console.error(`\ninit failed — ${describeError(err)}`)
      process.exitCode = 1
    }
  })

const TICK = '\u2713'
const tick = TICK
const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`
const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`

/** Ctrl-C out of a prompt is a cancellation, not a crash. */
function isCancel(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ExitPromptError'
}

async function ask(opts: {
  message: string
  default?: string
  auto: boolean
  validate?: (value: string) => true | string
}): Promise<string> {
  if (opts.auto) return opts.default ?? ''
  return (
    await input({
      message: opts.message,
      ...(opts.default !== undefined ? { default: opts.default } : {}),
      ...(opts.validate ? { validate: opts.validate } : {}),
    })
  ).trim()
}

export function normalizeAgentNames(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s))
}

async function askRepo(name: string, auto: boolean): Promise<string> {
  if (auto) return '.'
  const repo = await input({
    message: `Repo "${name}" works on ${dim('(path or git URL)')}`,
    default: '.',
    validate: (value: string) =>
      looksLikeRepo(value.trim())
        ? true
        : `"${value.trim()}" is not a git repo or a clone URL. Give a path containing .git, or a URL.`,
  })
  return repo.trim()
}

/**
 * Claim an inbox, and when the username is taken, offer the alternatives the
 * provider suggested rather than dying. The shared `agentmail.to` domain means
 * obvious names — friday, backend — are frequently gone, so this is the normal
 * path, not an edge case.
 */
async function claimInbox(
  transport: AgentMailTransport,
  name: string,
  display: string,
  auto: boolean,
): Promise<{ inboxId: string; email: string } | undefined> {
  let username = name
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await transport.ensureInbox(username, display)
    } catch (err) {
      if (!(err instanceof InboxTakenError)) {
        console.error(`  ${'\u2717'} inbox for "${name}" — ${describeError(err)}`)
        return undefined
      }
      console.log(`  ${'\u2717'} "${username}" is taken on this domain.`)
      if (auto) {
        const fallback = err.suggestions[0]
        if (fallback === undefined) return undefined
        console.log(`     using "${fallback}"`)
        username = fallback
        continue
      }
      const choices = [
        ...err.suggestions.map((s) => ({ name: s, value: s })),
        { name: 'Type a different name…', value: '\u0000custom' },
        { name: 'Cancel', value: '\u0000cancel' },
      ]
      const picked = await select({
        message: `Pick an inbox name for "${name}"`,
        choices,
        ...(err.suggestions.length > 0 ? { default: err.suggestions[0] } : {}),
      })
      if (picked === '\u0000cancel') return undefined
      username =
        picked === '\u0000custom'
          ? (
              await input({
                message: `Inbox name for "${name}"`,
                validate: (v: string) =>
                  /^[a-z0-9][a-z0-9._-]*$/.test(v.trim().toLowerCase())
                    ? true
                    : 'Lowercase letters, digits, dots, dashes and underscores.',
              })
            )
              .trim()
              .toLowerCase()
          : picked
    }
  }
  console.error(`  Gave up finding a free inbox name for "${name}".`)
  return undefined
}

/** A path we can actually cut a worktree from, or a URL we can clone. */
function looksLikeRepo(spec: string): boolean {
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(spec)) return true
  return existsSync(join(spec, '.git'))
}

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
    const created = await transport.raw.pods.create({ name, clientId: clientId('harness', name) })
    return created.podId
  } catch (err) {
    console.log(`  note: no pod scoping — ${describeError(err)}`)
    console.log('        (harmless: the daemon subscribes per-inbox instead)')
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
    console.log(`  note: no per-inbox key for "${name}" — ${describeError(err)}`)
    console.log('        (the org key will be used instead)')
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

/* ---------------------------------------------------------------- reset */

program
  .command('reset')
  .description('clear tasks, worktrees and history for a clean run — keeps harness.yaml and .env')
  .option('-c, --config <path>', 'config path', 'harness.yaml')
  .option('-y, --yes', 'skip the confirmation')
  .option('--keep-answers', 'keep the answer cache and DECISIONS.md')
  .option('--repos', 'also delete cloned repos, forcing a fresh clone')
  .action(async (opts) => {
    const cfg = load(opts.config)
    const root = '.harness'

    if (!opts.yes) {
      const ok = await confirm({
        message:
          `Clear all tasks, worktrees and history for pod "${cfg.pod}"? ` +
          `Inboxes and keys are untouched.`,
        default: false,
      }).catch(() => false)
      if (!ok) {
        console.log('Nothing was changed.')
        return
      }
    }

    // Remove worktrees through git so the source repo's registrations go too;
    // deleting the directories alone leaves them listed in `git worktree list`
    // and the next run with the same task id fails to re-create them.
    const store = new Store(join(root, 'journal.db'))
    let removed = 0
    for (const task of store.listTasks()) {
      if (!task.worktree || !existsSync(task.worktree)) continue
      const agent = cfg.agents.find((a) => a.name === task.agent)
      try {
        await removeWorktree({
          taskId: task.task_id,
          path: task.worktree,
          repo: agent ? resolveRepoPath(agent.repo, root) : task.worktree,
          branch: `harness/${task.task_id}`,
        })
        removed++
      } catch {
        await rm(task.worktree, { recursive: true, force: true })
        removed++
      }
    }
    if (removed > 0) console.log(`  ${TICK} removed ${removed} worktree(s)`)

    const counts = store.clearAll()
    console.log(
      `  ${TICK} cleared the journal (${counts.tasks} task(s), ${counts.seen} seen message(s), ` +
        `${counts.questions} question(s))`,
    )

    // Point every cursor at now. Without this the next `up` would replay the
    // whole mailbox — every old task and every doctor probe — because an
    // absent cursor means "start from the beginning".
    const now = Date.now()
    for (const agent of cfg.agents) store.forceCursor(inboxOf(agent), now)
    store.close()
    console.log(`  ${TICK} cursors set to now — existing mail will not be replayed`)

    await rm(join(root, 'wt'), { recursive: true, force: true })

    if (!opts.keepAnswers) {
      await rm(ANSWERS_PATH, { force: true })
      await rm(DECISIONS_PATH, { force: true })
      console.log(`  ${TICK} cleared the answer cache and ${DECISIONS_PATH}`)
    }
    if (opts.repos) {
      await rm(join(root, 'repos'), { recursive: true, force: true })
      console.log(`  ${TICK} removed cloned repos — the next task re-clones`)
    }

    console.log(`\nPod "${cfg.pod}" is clean. \`harness up\` starts fresh.`)
  })

/** Where a repo spec actually lives on disk, mirroring worktree.ts. */
function resolveRepoPath(spec: string, root: string): string {
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(spec)) {
    const name = spec.replace(/\.git$/, '').split(/[/:]/).pop() || 'repo'
    return join(root, 'repos', name)
  }
  return spec
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
  .option('--probe-timeout <seconds>', 'how long to wait for the probe to arrive', '120')
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

    // Every inbox, not just the first: each connects with its own key, and a
    // key that cannot subscribe is an agent that never wakes up.
    for (const agent of cfg.agents) {
      await check(`websocket (${agent.name})`, async () => {
        const transport = transportFor(cfg, agent.name)
        const sub = await transport.listen({ inboxIds: [inboxOf(agent)] }, () => undefined)
        sub.stop()
        return `subscribed to ${inboxOf(agent)}`
      })
    }

    if (!opts.skipRoundtrip) {
      // Q1 (§3): does the receive path preserve custom headers end-to-end?
      // This is that test, automated.
      const probeTimeout = Math.max(10, Number(opts.probeTimeout) || 120) * 1000
      await check('envelope round-trip (Q1)', async () => roundTrip(cfg, probeTimeout))
    }

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
    if (failures > 0) process.exitCode = 1
  })

/**
 * SPEC §7 Q1: "Do custom `headers` survive the full SES round-trip inbox→inbox?"
 *
 * Inbox→inbox, which is the whole point: a message addressed to the inbox that
 * sent it need not traverse the same delivery path, and may not come back at
 * all, so a self-addressed probe can answer the question neither way. With two
 * or more agents we send between two of them and read the headers off the
 * recipient with the recipient's own key — the exact path real traffic takes.
 */
async function roundTrip(cfg: HarnessConfig, timeoutMs: number): Promise<string> {
  const sender = cfg.agents[0]!
  const recipient = cfg.agents[1] ?? sender
  const selfAddressed = recipient === sender

  const senderTransport = transportFor(cfg, sender.name)
  const recipientTransport = transportFor(cfg, recipient.name)
  const from = inboxOf(sender)
  const to = inboxOf(recipient)

  // A unique token per run, so a probe from an earlier run cannot be mistaken
  // for this one and report a stale verdict.
  const token = mintTaskId()
  const subject = `harness doctor probe ${token}`
  const { headers, text } = envelope.encode(
    { taskId: token, hops: 1 },
    `Probe from \`harness doctor\`. If this landed in a human inbox, something is misrouted.`,
    cfg.envelope,
  )

  const startedAt = Date.now()
  await senderTransport.send(from, { to: [to], subject, text, headers })

  let arrivals = 0
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3_000))
    const refs = await recipientTransport.listSince(to, startedAt - 60_000, 50)
    arrivals = refs.length
    for (const ref of refs) {
      const message = await recipientTransport.getMessage(to, ref.messageId)
      if (!message.subject?.includes(token)) continue

      const parsed = envelope.parse(message.headers, message.text)
      if (parsed.taskId === token && parsed.hops === 1 && !parsed.human) {
        const path = selfAddressed ? `${from} → itself` : `${from} → ${to}`
        return `headers survived ${path} in ${Math.round((Date.now() - startedAt) / 1000)}s (${cfg.envelope} mode)`
      }
      throw new Error(
        `the probe arrived at ${to} but its envelope did not survive ` +
          `(task=${parsed.taskId ?? 'lost'}, hops=${parsed.hops}, ` +
          `${parsed.human ? 'no proto marker' : 'proto present'}). This is SPEC Q1 answered ` +
          `negatively: set \`envelope: trailer\` in harness.yaml and re-run — the fallback puts ` +
          `the same fields in the message body.`,
      )
    }
  }

  const waited = Math.round(timeoutMs / 1000)
  throw new Error(
    `no probe arrived at ${to} within ${waited}s ` +
      `(${arrivals} message(s) in that inbox meanwhile). This does NOT answer Q1 — nothing came ` +
      `back to inspect. Delivery may just be slower than ${waited}s on a new inbox: re-run with ` +
      `\`--probe-timeout 300\`.` +
      (selfAddressed
        ? ` Note this pod has one agent, so the probe was self-addressed, which some delivery ` +
          `paths drop; a second agent would make this a true inbox→inbox test.`
        : ''),
  )
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

export async function main(): Promise<void> {
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
