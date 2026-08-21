/**
 * §6 outreach: the permission gate, the question, the answer, and every path
 * that ends in "author unavailable". §10 milestone 3 in executable form.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { dispatch } from '../src/dispatch.js'
import { parseVerdict } from '../src/harness/outreach.js'
import * as answers from '../src/harness/answers.js'
import { BACKEND, REQUESTER, harness, scripted, type Harness } from './helpers.js'
import type { MailEvent } from '../src/transport/types.js'

const ADA = 'ada@example.com'
const BOB = 'bob@example.com'

/** A repo where Bob wrote the region and Ada wrote the file before him. */
function twoAuthorRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'harness-outreach-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', ADA)
  git('config', 'user.name', 'Ada Lovelace')
  writeFileSync(join(repo, 'retry.ts'), 'const cap = 1\nconst delay = 100\nexport { cap, delay }\n')
  git('add', '-A')
  git('commit', '-qm', 'first')
  git('config', 'user.email', BOB)
  git('config', 'user.name', 'Bob Barker')
  writeFileSync(join(repo, 'retry.ts'), 'const cap = 3\nconst delay = 100\nexport { cap, delay }\n')
  git('commit', '-qam', 'raise the cap')
  return repo
}

let h: Harness

/** The answer cache is scoped to the harness root, so each test gets its own. */
const answersPath = (): string => answers.answersPathFor(h.root)

beforeEach(() => {
  h = harness({}, twoAuthorRepo())
})

const inbound = (over: { from?: string; text?: string; threadId?: string; subject?: string } = {}) => {
  const message = h.transport.deliver({
    inboxId: BACKEND,
    from: over.from ?? REQUESTER,
    text: over.text ?? 'Please document the retry cap.',
    subject: over.subject ?? 'Document the retry cap',
    ...(over.threadId ? { threadId: over.threadId } : {}),
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

/** Run a task whose session asks the code author, and park it. */
async function park(): Promise<{ taskId: string; threadId: string }> {
  h.runner = scripted([
    {
      text: 'Parked while I wait for an answer about the retry cap.',
      call: async (ports) => {
        await ports.askCodeAuthor({
          file: 'retry.ts',
          lineStart: 1,
          lineEnd: 1,
          question: 'Why is the cap 3 rather than configurable?',
        })
      },
    },
  ])
  const { event, message } = inbound()
  const result = await dispatch(h, event)
  return { taskId: result.taskId!, threadId: message.threadId }
}

describe('parseVerdict (§6.2)', () => {
  it.each([
    ['yes', 'yes'],
    ['Yes, go ahead.', 'yes'],
    ['  OK  ', 'yes'],
    ['no', 'no'],
    ['No — he left the company.', 'no'],
    ['skip', 'skip'],
    ['Skip this one please', 'skip'],
  ])('%s → %s', (body, expected) => {
    expect(parseVerdict(body)).toBe(expected)
  })

  it('reads only the first non-quoted line', () => {
    expect(parseVerdict('\n\nyes\n\nno actually maybe')).toBe('yes')
    expect(parseVerdict('> yes\nno')).toBe('unclear')
  })

  it('is unclear on anything else', () => {
    expect(parseVerdict('I suppose so?')).toBe('unclear')
    expect(parseVerdict('')).toBe('unclear')
  })
})

describe('the ask flow (§6.2)', () => {
  it('parks the task and asks the requester for permission first', async () => {
    const { taskId } = await park()

    expect(h.store.getTask(taskId)!.state).toBe('awaiting-human')
    const permission = h.transport.sent.find((s) => s.subject.startsWith('Permission:'))!
    expect(permission.to).toEqual([REQUESTER])
    expect(permission.subject).toBe('Permission: may I email Bob Barker?')
    expect(permission.text).toContain('Why is the cap 3')
    expect(permission.text).toContain(BOB)

    // Nothing has reached the author yet.
    expect(h.transport.sent.some((s) => s.to.includes(BOB))).toBe(false)
    expect(h.store.listQuestions(taskId)[0]!.state).toBe('pending-permission')
  })

  it('`yes` sends the question to the author and CCs the requester', async () => {
    const { taskId, threadId } = await park()
    const questionId = h.store.listQuestions(taskId)[0]!.question_id

    h.runner = scripted([{ text: 'unused' }])
    const verdict = inbound({ text: 'yes', threadId })
    verdict.message.headers['x-harness-permission'] = questionId
    await dispatch(h, verdict.event)

    const question = h.transport.sent.find((s) => s.to.includes(BOB))!
    expect(question.cc).toEqual([REQUESTER])
    expect(question.text).toContain('Why is the cap 3')
    expect(question.text).toContain('const cap = 3') // the code excerpt
    expect(question.text).toContain('reply **skip**') // the fixed footer
    expect(h.store.getQuestion(questionId)!.state).toBe('sent')
    expect(h.store.outreachCount(BOB)).toBe(1)
  })

  it('`no` resumes the session with the conservative instruction and sends nothing', async () => {
    const { taskId, threadId } = await park()
    let resumePrompt = ''
    h.runner = ({ prompt }) => {
      resumePrompt = prompt
      return scripted([{ text: 'Assumed the cap is deliberate; noted it in the patch.' }])({
        prompt,
        options: {},
        ports: { askCodeAuthor: async () => ({ kind: 'refused', reason: '' }), sendEmailToAgent: async () => ({ kind: 'refused', reason: '' }) },
      })
    }
    await dispatch(h, inbound({ text: 'no', threadId }).event)

    expect(h.transport.sent.some((s) => s.to.includes(BOB))).toBe(false)
    expect(h.store.listQuestions(taskId)[0]!.state).toBe('skipped')
    expect(resumePrompt).toContain('make the conservative choice and flag it in the PR description')
    expect(h.store.getTask(taskId)!.state).toBe('done')
  })

  it('`skip` behaves the same way', async () => {
    const { taskId, threadId } = await park()
    h.runner = scripted([{ text: 'Made the conservative choice.' }])
    await dispatch(h, inbound({ text: 'skip', threadId }).event)
    expect(h.store.listQuestions(taskId)[0]!.state).toBe('skipped')
    expect(h.transport.sent.some((s) => s.to.includes(BOB))).toBe(false)
  })

  it('an unreadable verdict is re-asked once, then treated as no', async () => {
    const { taskId, threadId } = await park()
    h.runner = scripted([{ text: 'Made the conservative choice.' }])

    await dispatch(h, inbound({ text: 'I dunno, what do you think?', threadId }).event)
    const reasks = h.transport.sent.filter((s) => s.text.includes('could not read a verdict'))
    expect(reasks.length).toBe(1)
    expect(h.store.listQuestions(taskId)[0]!.state).toBe('pending-permission')

    await dispatch(h, inbound({ text: 'still not sure', threadId }).event)
    expect(h.store.listQuestions(taskId)[0]!.state).toBe('skipped')
    expect(h.transport.sent.filter((s) => s.text.includes('could not read a verdict')).length).toBe(1)
  })
})

describe('the answer path (§6.3, §8)', () => {
  async function sendQuestionTo(): Promise<{ taskId: string; threadId: string; questionId: string }> {
    const parked = await park()
    const questionId = h.store.listQuestions(parked.taskId)[0]!.question_id
    h.runner = scripted([{ text: 'unused' }])
    const verdict = inbound({ text: 'yes', threadId: parked.threadId })
    verdict.message.headers['x-harness-permission'] = questionId
    await dispatch(h, verdict.event)
    return { ...parked, questionId }
  }

  it('routes the author reply back into the parked task and records the answer', async () => {
    const { taskId, questionId } = await sendQuestionTo()

    let resumePrompt = ''
    h.runner = ({ prompt }) => {
      resumePrompt = prompt
      return scripted([{ text: 'Documented it as a deliberate cap.' }])({
        prompt,
        options: {},
        ports: { askCodeAuthor: async () => ({ kind: 'refused', reason: '' }), sendEmailToAgent: async () => ({ kind: 'refused', reason: '' }) },
      })
    }

    const answer = inbound({
      from: 'Bob Barker <bob@example.com>',
      text: 'It is deliberate — the upstream API rate-limits us at 5/min.\n\n> Why is the cap 3',
    })
    const result = await dispatch(h, answer.event)

    expect(result.disposition).toBe('outreach-resume')
    expect(h.store.getQuestion(questionId)!.state).toBe('answered')
    expect(resumePrompt).toContain('rate-limits us at 5/min')
    expect(resumePrompt).toContain('untrusted-email-content')
    expect(h.store.getTask(taskId)!.state).toBe('done')

    const records = await answers.readAnswers(answersPath())
    const record = records.find((r) => r.question.includes('Why is the cap 3'))!
    expect(record.answered_by).toBe(BOB)
    expect(record.answer).toContain('rate-limits')
    expect(answers.renderDecisions([record])).toContain('rate-limits')
  })

  it('an author who replies "skip" is not asked again', async () => {
    const { taskId, questionId } = await sendQuestionTo()
    h.runner = scripted([{ text: 'Made the conservative choice.' }])
    await dispatch(h, inbound({ from: BOB, text: 'skip' }).event)
    expect(h.store.getQuestion(questionId)!.state).toBe('skipped')
    expect(h.store.getTask(taskId)!.state).toBe('done')
  })
})

describe('the cache (§8)', () => {
  it('a repeat question on the same lines is served from cache with no email', async () => {
    await answers.appendAnswer(
      {
      file: 'retry.ts',
      line_start: 1,
      line_end: 2,
      sha: 'oldsha00',
      asked: BOB,
      answered_by: BOB,
      question: 'Why is the cap 3?',
      answer: 'Upstream rate-limits at 5/min.',
      at: Date.now(),
      },
      answersPath(),
    )

    let served: unknown
    h.runner = scripted([
      {
        text: 'Used the cached answer.',
        call: async (ports) => {
          served = await ports.askCodeAuthor({
            file: 'retry.ts',
            lineStart: 1,
            lineEnd: 1,
            question: 'Why is the cap 3 rather than configurable?',
          })
        },
      },
    ])
    const result = await dispatch(h, inbound().event)

    expect(served).toMatchObject({ kind: 'cached' })
    expect((served as { answer: string }).answer).toContain('rate-limits')
    expect((served as { note: string }).note).toContain('has since changed') // stale, not fatal
    expect(h.transport.sent.some((s) => s.subject.startsWith('Permission:'))).toBe(false)
    expect(h.store.listQuestions(result.taskId!).length).toBe(0)
    expect(h.store.getTask(result.taskId!)!.state).toBe('done')
  })
})

describe('policy and budget refusals (§6.1, §6.3)', () => {
  it('refuses outreach to an author outside the allowlist', async () => {
    h = harness({ allowlist: { domains: ['example.net'] } }, twoAuthorRepo())
    let refusal: { kind: string; reason?: string } | undefined
    h.runner = scripted([
      {
        text: 'Made the conservative choice.',
        call: async (ports) => {
          refusal = (await ports.askCodeAuthor({
            file: 'retry.ts',
            lineStart: 1,
            lineEnd: 1,
            question: 'why?',
          })) as never
        },
      },
    ])
    await dispatch(h, inbound().event)
    expect(refusal!.kind).toBe('refused')
    expect(refusal!.reason).toContain('denied by policy')
    expect(h.transport.sent.some((s) => s.subject.startsWith('Permission:'))).toBe(false)
  })

  it('enforces the per-person weekly budget across tasks', async () => {
    h.store.bumpOutreach(BOB)
    h.store.bumpOutreach(BOB)
    h.store.bumpOutreach(BOB)

    let refusal: { kind: string; reason?: string } | undefined
    h.runner = scripted([
      {
        text: 'Made the conservative choice.',
        call: async (ports) => {
          refusal = (await ports.askCodeAuthor({
            file: 'retry.ts',
            lineStart: 1,
            lineEnd: 1,
            question: 'why?',
          })) as never
        },
      },
    ])
    await dispatch(h, inbound().event)
    expect(refusal!.kind).toBe('refused')
    expect(refusal!.reason).toContain('limit 3')
  })

  it('refuses when the file has no history to blame', async () => {
    let refusal: { kind: string; reason?: string } | undefined
    h.runner = scripted([
      {
        text: 'Made the conservative choice.',
        call: async (ports) => {
          refusal = (await ports.askCodeAuthor({
            file: 'does-not-exist.ts',
            lineStart: 1,
            lineEnd: 1,
            question: 'why?',
          })) as never
        },
      },
    ])
    await dispatch(h, inbound().event)
    expect(refusal!.kind).toBe('refused')
    expect(refusal!.reason).toContain('no git history')
  })
})

describe('bounce fallback (§6.3)', () => {
  it('retries once with the next-most-recent author of the same region', async () => {
    const parked = await park()
    const questionId = h.store.listQuestions(parked.taskId)[0]!.question_id
    h.runner = scripted([{ text: 'unused' }])
    const verdict = inbound({ text: 'yes', threadId: parked.threadId })
    verdict.message.headers['x-harness-permission'] = questionId
    await dispatch(h, verdict.event)
    expect(h.store.getQuestion(questionId)!.asked_email).toBe(BOB)

    const bounce: MailEvent = {
      kind: 'message.bounced',
      inboxId: BACKEND,
      messageId: 'm-bounce',
      recipients: [BOB],
      reason: 'Permanent/NoSuchUser',
      at: Date.now(),
    }
    const result = await dispatch(h, bounce)

    expect(result.detail).toContain(ADA)
    expect(h.store.getQuestion(questionId)!.state).toBe('sent')
    expect(h.store.getQuestion(questionId)!.asked_email).toBe(ADA)
    expect(h.transport.sent.filter((s) => s.to.includes(ADA)).length).toBe(1)
  })

  it('behaves as skip when there is nobody else to ask', async () => {
    const parked = await park()
    const questionId = h.store.listQuestions(parked.taskId)[0]!.question_id
    h.store.updateQuestion(questionId, { state: 'sent', asked_email: BOB })
    // Blow the weekly budget so the fallback author is refused too.
    for (let i = 0; i < 3; i++) h.store.bumpOutreach(ADA)

    h.runner = scripted([{ text: 'Made the conservative choice.' }])
    const result = await dispatch(h, {
      kind: 'message.bounced',
      inboxId: BACKEND,
      messageId: 'm-bounce',
      recipients: [BOB],
      at: Date.now(),
    })

    expect(result.disposition).toBe('bounce-handled')
    expect(h.store.getQuestion(questionId)!.state).toBe('bounced')
    expect(h.store.getTask(parked.taskId)!.state).toBe('done')
  })
})
