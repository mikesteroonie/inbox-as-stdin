/**
 * Standalone MCP server for `send_email_to_agent` (SPEC §6): "falls out of
 * milestone 4 as a byproduct so Claude Code users can join a swarm without
 * running the daemon."
 *
 * This is the send half only, and deliberately so. A Claude Code session at a
 * terminal already has a human present — it does not need the daemon's wake-up,
 * worktrees, or park/resume. What it needs is the ability to hand work to a pod
 * agent under the same policy the daemon enforces, so a human-driven session
 * cannot mail anyone the daemon would refuse.
 *
 * Run it with `harness mcp --agent <name>`; point a client at that command.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { AgentConfig, HarnessConfig } from './config.js'
import * as envelope from './envelope.js'
import { inboxOf } from './dispatch.js'
import { rosterAddresses } from './harness/outreach.js'
import { classifyRecipient, normalizeAddress } from './policy.js'
import type { MailTransport } from './transport/types.js'

export const MCP_SERVER_NAME = 'harness'

export interface McpDeps {
  cfg: HarnessConfig
  /** The agent whose inbox this server sends from. */
  agent: AgentConfig
  transport: MailTransport
}

/**
 * Build the server without connecting it, so the policy path is testable
 * without a stdio pipe.
 */
export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: '0.1.0' },
    {
      instructions:
        `Send email to agents in the "${deps.cfg.pod}" pod, from ` +
        `${inboxOf(deps.agent)}. Recipients are checked against the pod roster before ` +
        `anything leaves; a refusal comes back as a normal result. This is the only ` +
        `sanctioned way to reach a pod agent — do not use curl or an SMTP client.`,
    },
  )

  server.registerTool(
    'send_email_to_agent',
    {
      title: 'Send email to a pod agent',
      description:
        `Email an agent in the "${deps.cfg.pod}" pod and hand it a task. The agent works ` +
        `asynchronously and replies by email, so this returns as soon as the message is ` +
        `sent — it does not wait for an answer. Recipients outside the pod roster are ` +
        `refused: people are reached by writing to them yourself, not through this tool.`,
      inputSchema: {
        to: z
          .string()
          .describe(`Agent inbox or agent name. Roster: ${rosterNames(deps.cfg)}.`),
        subject: z.string().describe('Subject line. It is how the thread is found later.'),
        body: z
          .string()
          .describe('Plain-text body. State the task and everything needed to act on it.'),
      },
    },
    async ({ to, subject, body }) => {
      const result = await sendToPodAgent(deps, { to, subject, body })
      return {
        content: [{ type: 'text' as const, text: result.text }],
        ...(result.ok ? {} : { isError: true }),
      }
    },
  )

  return server
}

function rosterNames(cfg: HarnessConfig): string {
  return cfg.agents.map((a) => `${a.name} (${inboxOf(a)})`).join(', ')
}

/** Resolve an agent name or address, then apply the §6.1 tiers. */
export async function sendToPodAgent(
  deps: McpDeps,
  input: { to: string; subject: string; body: string },
): Promise<{ ok: boolean; text: string }> {
  const byName = deps.cfg.agents.find((a) => a.name === input.to.trim().toLowerCase())
  const target = normalizeAddress(byName ? inboxOf(byName) : input.to)
  if (target === undefined) {
    return { ok: false, text: `"${input.to}" is not an agent name or an email address.` }
  }

  const verdict = classifyRecipient({
    recipient: target,
    roster: rosterAddresses(deps.cfg),
    allowlistDomains: deps.cfg.allowlist.domains,
  })
  if (verdict.tier !== 'auto') {
    return {
      ok: false,
      text:
        `Not sent — ${target} is not an agent in the "${deps.cfg.pod}" pod ` +
        `(${verdict.reason}). Roster: ${rosterNames(deps.cfg)}.`,
    }
  }

  // Hop 1: this is the start of a chain, and the daemon's hop cap governs it
  // from here on, so an agent cannot bounce work back through this bridge
  // forever.
  const { headers, text } = envelope.encode({ hops: 1 }, input.body, deps.cfg.envelope)
  const res = await deps.transport.send(inboxOf(deps.agent), {
    to: [target],
    subject: input.subject,
    text,
    headers,
  })
  return {
    ok: true,
    text:
      `Sent to ${target} on thread ${res.threadId}. It will reply by email to ` +
      `${inboxOf(deps.agent)}; watch that inbox, or run \`harness tail ${res.threadId}\`.`,
  }
}

export async function serveStdio(deps: McpDeps): Promise<void> {
  const server = buildMcpServer(deps)
  await server.connect(new StdioServerTransport())
}
