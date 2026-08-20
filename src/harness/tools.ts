/**
 * The two tools the harness adds to a session (§7).
 *
 * Both are thin: they validate, delegate to a port, and format a result. The
 * policy lives in `policy.ts` and the side effects live in `outreach.ts`, so
 * these can be exercised without an SDK, a network, or a mailbox.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/** What `ask_code_author` returns to the model. */
export type AskResult =
  | { kind: 'parked'; questionId: string }
  | { kind: 'cached'; answer: string; note: string }
  | { kind: 'refused'; reason: string }

/** What `send_email_to_agent` returns to the model. */
export type SendResult =
  | { kind: 'sent'; threadId: string; hops: number }
  | { kind: 'refused'; reason: string }

export interface HarnessPorts {
  askCodeAuthor(input: {
    file: string
    lineStart: number
    lineEnd: number
    question: string
  }): Promise<AskResult>
  sendEmailToAgent(input: {
    to: string
    subject: string
    body: string
    threadId?: string
  }): Promise<SendResult>
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const failure = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true })

export const SERVER_NAME = 'harness'

/** Fully-qualified names, for `allowedTools`. */
export const TOOL_NAMES = {
  sendEmailToAgent: `mcp__${SERVER_NAME}__send_email_to_agent`,
  askCodeAuthor: `mcp__${SERVER_NAME}__ask_code_author`,
} as const

/**
 * The tool definitions, separate from the server that hosts them, so the text
 * the model actually receives — including every refusal wording — can be
 * asserted without standing up an MCP transport.
 */
export function harnessToolDefinitions(ports: HarnessPorts) {
  const sendEmailToAgent = tool(
    'send_email_to_agent',
    'Email another agent in this pod. The recipient is checked against the pod roster and the ' +
      'outreach policy before anything is sent; a refusal comes back as a normal result, not an ' +
      'error. Use this to delegate work or to ask a peer agent a question — not to reply to the ' +
      'requester, whose reply is sent for you when you finish.',
    {
      to: z.string().describe('Recipient address. Must be an agent inbox in this pod.'),
      subject: z.string().describe('Subject line. Be specific; it is how the thread is found later.'),
      body: z
        .string()
        .describe('Message body, plain text. State the ask and the context needed to act on it.'),
      thread_id: z
        .string()
        .optional()
        .describe('Existing thread to continue. Omit to start a new thread.'),
    },
    async (args) => {
      const result = await ports.sendEmailToAgent({
        to: args.to,
        subject: args.subject,
        body: args.body,
        ...(args.thread_id ? { threadId: args.thread_id } : {}),
      })
      if (result.kind === 'refused') {
        return failure(`Not sent — ${result.reason}. Do not try another route to reach them.`)
      }
      return text(
        `Sent to ${args.to} on thread ${result.threadId} (hop ${result.hops}). ` +
          `Their reply will arrive as a new message on this task; you do not need to wait for it now.`,
      )
    },
  )

  const askCodeAuthor = tool(
    'ask_code_author',
    'Ask the human who wrote a piece of code ONE specific question about it. This parks you: the ' +
      'harness asks the requester for permission, emails the author, ends your session, and ' +
      'resumes you with the answer. Write down everything you have worked out before calling it. ' +
      'Only ask what the repository cannot tell you — intent, a deliberate tradeoff, a constraint ' +
      'that is not written down.',
    {
      file: z.string().describe('Repo-relative path of the file in question.'),
      line_start: z.number().int().positive().describe('First line of the region you are asking about.'),
      line_end: z.number().int().positive().describe('Last line of the region (same as line_start for one line).'),
      question: z
        .string()
        .describe(
          'One specific question, answerable in a sentence or two by someone who has not been ' +
            'following your work. Include what you already tried to infer.',
        ),
    },
    async (args) => {
      if (args.line_end < args.line_start) {
        return failure('line_end must be greater than or equal to line_start.')
      }
      const result = await ports.askCodeAuthor({
        file: args.file,
        lineStart: args.line_start,
        lineEnd: args.line_end,
        question: args.question,
      })
      switch (result.kind) {
        case 'cached':
          return text(
            `Already answered — no email sent (${result.note}):\n\n${result.answer}\n\n` +
              `Continue with this answer. Do not ask again about these lines.`,
          )
        case 'refused':
          return text(
            `Not asked — ${result.reason}. The author is unavailable: make the conservative ` +
              `choice, state the assumption in your final reply, and continue.`,
          )
        case 'parked':
          return text(
            `parked (${result.questionId}). Stop now: write one short paragraph summarising ` +
              `where you got to and what you will do with each possible answer, then end your ` +
              `turn. Do not call any more tools — you will be resumed with the answer.`,
          )
      }
    },
  )

  return { sendEmailToAgent, askCodeAuthor }
}

export function createHarnessTools(ports: HarnessPorts) {
  const { sendEmailToAgent, askCodeAuthor } = harnessToolDefinitions(ports)
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    instructions:
      'Tools provided by the email harness. Outbound mail may only leave through these; any ' +
      'other send path is a policy violation.',
    tools: [sendEmailToAgent, askCodeAuthor],
  })
}
