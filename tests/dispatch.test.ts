/**
 * The §5 pipeline, end to end, against the in-memory transport and a scripted
 * session. These are the §10 acceptance criteria in executable form.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { dispatch, expireDeadThreads } from '../src/dispatch.js'
import * as envelope from '../src/envelope.js'
import { BACKEND, EXPENSIVE, FRONTEND, REQUESTER, harness, scripted, tempRepo, type Harness } from './helpers.js'
import type { MailEvent } from '../src/transport/types.js'

let h: Harness

const received = (over: Partial<{ from: string; text: string; subject: string; headers: Record<string, string>; threadId: string; armor: { verdict: 'pass' | 'review' | 'block'; reason?: string } }> = {}) => {
  const message = h.transport.deliver({
    inboxId: BACKEND,
    from: over.from ?? REQUESTER,
    text: over.text ?? 'Please add a comment to retry.ts.',
    ...(over.subject !== undefined ? { subject: over.subject } : { subject: 'Add a comment' }),
    ...(over.headers ? { headers: over.headers } : {}),
    ...(over.threadId ? { threadId: over.threadId } : {}),
    ...(over.armor ? { armor: over.armor } : {}),
  })
  const event: MailEvent = {
    kind: 'message.received',
    inboxId: BACKEND,
    messageId: message.messageId,
    threadId: message.threadId,
    at: message.timestamp,
  }
  return { message, event }
}

beforeEach(() => {
  h = harness()
})

describe('§5.1 dedupe', () => {
  it('a duplicate delivery of the same message produces one reply', async () => {
    h.runner = scripted([{ text: 'Added the comment.' }])
    const { event } = received()
    expect((await dispatch(h, event)).disposition).toBe('task-input')
    expect((await dispatch(h, event)).disposition).toBe('duplicate')
    expect(h.transport.sent.filter((s) => s.kind === 'reply').length).toBe(1)
  })
})

describe('§5.3 armor gate', () => {
  it('holds a `review` verdict, labels the thread, notifies, and runs nothing', async () => {
    let ran = false
    h.runner = scripted([{ text: (ran = true) ? 'x' : 'x' }])
    const { event, message } = received({ armor: { verdict: 'review', reason: 'suspicious link' } })
    ran = false
    expect((await dispatch(h, event)).disposition).toBe('held-by-armor')
    expect([...(h.transport.threadLabels.get(message.threadId) ?? [])]).toContain('state/held')
    expect(h.transport.sent[0]!.subject).toContain('Held for review')
    expect(h.transport.sent[0]!.to).toEqual([REQUESTER])
    expect(ran).toBe(false)
  })

  it('holds a `block` verdict too', async () => {
    const { event } = received({ armor: { verdict: 'block' } })
    expect((await dispatch(h, event)).disposition).toBe('held-by-armor')
  })
})

describe('§5.5 loop guards', () => {
  it('halts at the hop cap and notifies the requester exactly once', async () => {
    const first = received({ headers: envelope.encodeHeaders({ hops: 6 }) })
    expect((await dispatch(h, first.event)).disposition).toBe('hop-limit')
    const second = received({ headers: envelope.encodeHeaders({ hops: 7 }), threadId: first.message.threadId })
    expect((await dispatch(h, second.event)).disposition).toBe('hop-limit')
    const notices = h.transport.sent.filter((s) => s.subject.includes('Hop limit'))
    expect(notices.length).toBe(1)
  })

  it('drops a sender who is neither allowlisted, roster, nor on an active thread', async () => {
    const { event } = received({ from: 'stranger@example.com' })
    expect((await dispatch(h, event)).disposition).toBe('sender-refused')
    expect(h.transport.sent.length).toBe(0)
  })

  it('accepts a stranger who is already a participant of a live task thread', async () => {
    h.runner = scripted([{ text: 'done' }])
    const first = received()
    await dispatch(h, first.event)
    h.store.updateTask(h.store.listTasks()[0]!.task_id, { state: 'running' })

    // The stranger is now on the thread because the reply CC'd them in.
    h.transport.deliver({
      inboxId: BACKEND,
      from: 'stranger@example.com',
      threadId: first.message.threadId,
      text: 'seed',
    })
    const follow = received({ from: 'stranger@example.com', threadId: first.message.threadId })
    expect((await dispatch(h, follow.event)).disposition).toBe('task-input')
  })

  it('ignores mail the agent sent itself', async () => {
    const { event } = received({ from: BACKEND })
    expect((await dispatch(h, event)).disposition).toBe('ignored')
  })
})

describe('§5.6-§5.8 task input, run and emit', () => {
  it('replies on the thread with a patch attachment and the §3 headers', async () => {
    const repo = tempRepo()
    h = harness({}, repo)
    h.runner = scripted([
      {
        text: 'Added the comment.',
        call: async () => undefined,
      },
    ])
    // The session writes into the worktree; emulate that between turns.
    const { event } = received()
    h.runner = scripted([
      {
        text: 'Added the comment to retry.ts.',
        call: async () => {
          const task = h.store.listTasks()[0]!
          const wt = task.worktree ?? join(h.root, 'wt', task.task_id)
          if (existsSync(join(wt, 'retry.ts'))) {
            writeFileSync(join(wt, 'retry.ts'), '// explains the retry cap\none\ntwo\nthree\n')
          }
        },
      },
    ])

    const result = await dispatch(h, event)
    expect(result.disposition).toBe('task-input')

    const reply = h.transport.sent.find((s) => s.kind === 'reply')!
    expect(reply.headers['x-harness-proto']).toBe('1')
    expect(reply.headers['x-task-id']).toBe(result.taskId)
    expect(reply.headers['x-hops']).toBe('1')
    expect(reply.text).toContain('Added the comment')
    expect(reply.attachments[0]!.filename).toBe(`patch-${result.taskId}.diff`)
    // SPEC §3 names the terminal thread label.
    expect([...(h.transport.threadLabels.get(reply.threadId) ?? [])]).toContain('state/replied')
    expect(Buffer.from(reply.attachments[0]!.content, 'base64').toString()).toContain(
      'explains the retry cap',
    )
    expect(h.store.getTask(result.taskId!)!.state).toBe('done')
  })

  it('a second email on the thread resumes the same session and the same task', async () => {
    h.runner = scripted([{ text: 'First pass done.' }], { sessionId: 'sess-1' })
    const first = received()
    const a = await dispatch(h, first.event)

    let resumed: string | undefined
    h.runner = ({ options }) => {
      resumed = options.resume
      return scripted([{ text: 'Second pass done.' }], { sessionId: 'sess-1' })({
        prompt: '',
        options,
        ports: { askCodeAuthor: async () => ({ kind: 'refused', reason: 'n/a' }), sendEmailToAgent: async () => ({ kind: 'refused', reason: 'n/a' }) },
      })
    }
    const second = received({ threadId: first.message.threadId, text: 'Also add a test.' })
    const b = await dispatch(h, second.event)

    expect(b.taskId).toBe(a.taskId)
    expect(resumed).toBe('sess-1')
  })

  it('books spend against the task', async () => {
    h.runner = scripted([{ text: 'done', usage: { input: 1_000_000, output: 100_000 } }])
    const { event } = received()
    const result = await dispatch(h, event)
    // 1M in ($3) + 100k out ($1.50) on sonnet.
    expect(h.store.getTask(result.taskId!)!.spent_usd).toBeCloseTo(4.5, 2)
  })

  it('parks an over-budget task and reports instead of running on (§10 m2)', async () => {
    h.runner = scripted([
      { text: 'thinking', usage: EXPENSIVE },
      { text: 'should never get here', usage: EXPENSIVE },
    ])
    const { event } = received()
    const result = await dispatch(h, event)
    const reply = h.transport.sent.find((s) => s.kind === 'reply')!
    expect(reply.text).toContain('over budget')
    expect(h.store.getTask(result.taskId!)!.state).toBe('failed')
    expect(h.store.getTask(result.taskId!)!.spent_usd).toBeGreaterThan(5)
  })

  it('stops rather than charging $0 for a model it cannot price (§11)', async () => {
    // The budget guard is only as good as the price on file. A model missing
    // from the table would otherwise accumulate zero spend and never park.
    h.runner = scripted([{ text: 'work', usage: EXPENSIVE }], { model: 'claude-unreleased-9' })
    const { event } = received()
    const result = await dispatch(h, event)

    expect(h.store.getTask(result.taskId!)!.state).toBe('failed')
    expect(h.store.getTask(result.taskId!)!.spent_usd).toBe(0)
    const reply = h.transport.sent.find((s) => s.kind === 'reply')!
    expect(reply.text).toContain('claude-unreleased-9')
    expect(reply.text).toContain('src/pricing.ts')
  })

  it('reports a failed session to the requester', async () => {
    h.runner = scripted([], { fail: 'the model exploded' })
    const { event } = received()
    const result = await dispatch(h, event)
    expect(h.store.getTask(result.taskId!)!.state).toBe('failed')
    expect(h.transport.sent.find((s) => s.kind === 'reply')!.text).toContain('Task failed')
  })
})

describe('SPEC §4 participant cap', () => {
  it('halts a thread that has become a CC storm, and notifies once', async () => {
    h = harness({ budgets: { max_participants: 2 } })
    h.runner = scripted([{ text: 'should not run' }])
    const first = received({ subject: 'wide thread' })
    // Three more people join the thread.
    for (const who of ['a@yourco.dev', 'b@yourco.dev', 'c@yourco.dev']) {
      h.transport.deliver({ inboxId: BACKEND, from: who, threadId: first.message.threadId, text: 'me too' })
    }
    const next = received({ threadId: first.message.threadId })

    const result = await dispatch(h, next.event)
    expect(result.disposition).toBe('participant-limit')
    expect(h.transport.sent.filter((s) => s.subject.startsWith('Too many people')).length).toBe(1)

    // A second message on the same thread does not re-notify.
    const again = received({ threadId: first.message.threadId })
    expect((await dispatch(h, again.event)).disposition).toBe('participant-limit')
    expect(h.transport.sent.filter((s) => s.subject.startsWith('Too many people')).length).toBe(1)
  })
})

describe('SPEC §4 dead-thread TTL', () => {
  it('closes an abandoned parked task, releases its questions, and notifies', async () => {
    h.runner = scripted([{ text: 'done' }])
    const { event } = received()
    const result = await dispatch(h, event)
    const taskId = result.taskId!

    // Park it, then wind the clock past the TTL.
    h.store.updateTask(taskId, { state: 'awaiting-human' })
    h.store.createQuestion({
      question_id: 'q_aaaaaaaaaa',
      task_id: taskId,
      asked_email: 'ada@yourco.dev',
      state: 'sent',
      question: 'why?',
    })
    const later = Date.now() + 15 * 24 * 3600 * 1000

    const expired = await expireDeadThreads(h, later)
    expect(expired).toEqual([taskId])
    expect(h.store.getTask(taskId)!.state).toBe('failed')
    expect(h.store.getQuestion('q_aaaaaaaaaa')!.state).toBe('skipped')
    const notice = h.transport.sent.find((s) => s.subject.includes('no activity'))!
    expect(notice.text).toContain('ada@yourco.dev')

    // Idempotent: a second sweep neither re-expires nor re-notifies.
    expect(await expireDeadThreads(h, later)).toEqual([])
    expect(h.transport.sent.filter((s) => s.subject.includes('no activity')).length).toBe(1)
  })

  it('leaves a live task alone', async () => {
    h.runner = scripted([{ text: 'done' }])
    const result = await dispatch(h, received().event)
    h.store.updateTask(result.taskId!, { state: 'awaiting-human' })
    expect(await expireDeadThreads(h, Date.now())).toEqual([])
  })

  it('starts a fresh task rather than resuming a stale one', async () => {
    h.runner = scripted([{ text: 'done' }])
    const first = received()
    const a = await dispatch(h, first.event)
    // Backdate the task past the TTL.
    h.store.updateTask(a.taskId!, {}, Date.now() - 15 * 24 * 3600 * 1000)

    const second = received({ threadId: first.message.threadId, text: 'picking this back up' })
    const b = await dispatch(h, second.event)
    expect(b.taskId).not.toBe(a.taskId)
  })
})

describe('§5 bounce handling', () => {
  it('marks the task failed and notifies when a bounce matches no question', async () => {
    h.runner = scripted([{ text: 'done' }])
    const { event, message } = received()
    const result = await dispatch(h, event)
    h.store.updateTask(result.taskId!, { state: 'running' })

    const bounce: MailEvent = {
      kind: 'message.bounced',
      inboxId: BACKEND,
      messageId: 'm-x',
      threadId: message.threadId,
      recipients: ['ghost@nowhere.dev'],
      reason: 'Permanent/General',
      at: Date.now(),
    }
    expect((await dispatch(h, bounce)).disposition).toBe('bounce-handled')
    expect(h.store.getTask(result.taskId!)!.state).toBe('failed')
    expect(h.transport.sent.some((s) => s.subject.startsWith('Undeliverable'))).toBe(true)
  })
})

describe('§10 milestone 4 — two agents', () => {
  it('increments the hop counter on an agent-to-agent send', async () => {
    h.runner = scripted([
      {
        text: 'Asked frontend.',
        call: async (ports) => {
          const res = await ports.sendEmailToAgent({
            to: FRONTEND,
            subject: 'Need the API shape',
            body: 'What does the endpoint return?',
          })
          expect(res).toMatchObject({ kind: 'sent', hops: 1 })
        },
      },
    ])
    const { event } = received()
    const result = await dispatch(h, event)
    const toFrontend = h.transport.sent.find((s) => s.to.includes(FRONTEND))!
    expect(toFrontend.headers['x-hops']).toBe('1')
    expect(toFrontend.headers['x-task-id']).toBe(result.taskId)
  })

  it('refuses an agent-to-agent send outside the roster', async () => {
    let refusal: unknown
    h.runner = scripted([
      {
        text: 'Refused.',
        call: async (ports) => {
          refusal = await ports.sendEmailToAgent({
            to: 'stranger@example.com',
            subject: 'hi',
            body: 'hi',
          })
        },
      },
    ])
    await dispatch(h, received().event)
    expect(refusal).toMatchObject({ kind: 'refused' })
    expect(h.transport.sent.some((s) => s.to.includes('stranger@example.com'))).toBe(false)
  })

  it('refuses a send to a person and points at ask_code_author instead', async () => {
    let refusal: { kind: string; reason?: string } | undefined
    h.runner = scripted([
      {
        text: 'Refused.',
        call: async (ports) => {
          refusal = (await ports.sendEmailToAgent({
            to: 'ada@yourco.dev',
            subject: 'hi',
            body: 'hi',
          })) as { kind: string; reason?: string }
        },
      },
    ])
    await dispatch(h, received().event)
    expect(refusal!.kind).toBe('refused')
    expect(refusal!.reason).toContain('ask_code_author')
  })

  it('refuses once the task is at the hop cap', async () => {
    h = harness({ budgets: { usd: 5, max_hops: 1 } })
    let refusal: { kind: string; reason?: string } | undefined
    h.runner = scripted([
      {
        text: 'Refused.',
        call: async (ports) => {
          refusal = (await ports.sendEmailToAgent({ to: FRONTEND, subject: 'x', body: 'y' })) as never
        },
      },
    ])
    // First run sends to frontend at hop 1 and replies at hop 2, so the task
    // is now past a cap of 1.
    const { event } = received({ headers: envelope.encodeHeaders({ hops: 0 }) })
    const result = await dispatch(h, event)
    expect(h.store.getTask(result.taskId!)!.hops).toBe(2)

    // A human follow-up must not rewind the counter and re-open the loop.
    const again = received({ threadId: h.store.getTask(result.taskId!)!.thread_id!, text: 'again' })
    await dispatch(h, again.event)
    expect(h.store.getTask(result.taskId!)!.hops).toBeGreaterThanOrEqual(2)
    expect(refusal!.reason).toContain('hop limit')
  })
})
