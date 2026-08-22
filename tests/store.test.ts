import { describe, expect, it } from 'vitest'
import { Store } from '../src/store.js'

const store = (): Store => new Store(':memory:')

describe('seen (§5.1 dedupe)', () => {
  it('is true the first time and false after', () => {
    const s = store()
    expect(s.markSeen('m1')).toBe(true)
    expect(s.markSeen('m1')).toBe(false)
    expect(s.hasSeen('m1')).toBe(true)
    expect(s.hasSeen('m2')).toBe(false)
    s.close()
  })

  it('prunes at 30 days', () => {
    const s = store()
    const old = Date.now() - 31 * 24 * 3600 * 1000
    s.markSeen('old', old)
    s.markSeen('new')
    expect(s.pruneSeen()).toBe(1)
    expect(s.hasSeen('old')).toBe(false)
    expect(s.hasSeen('new')).toBe(true)
    s.close()
  })
})

describe('tasks', () => {
  it('creates, reads and patches', () => {
    const s = store()
    const t = s.createTask({ task_id: 'aaaaaaaa', thread_id: 'thr1', agent: 'backend' })
    expect(t.state).toBe('running')
    expect(t.spent_usd).toBe(0)
    s.updateTask('aaaaaaaa', { state: 'done', worktree: '/tmp/wt', hops: 2 })
    const after = s.getTask('aaaaaaaa')!
    expect(after.state).toBe('done')
    expect(after.worktree).toBe('/tmp/wt')
    expect(after.hops).toBe(2)
    s.close()
  })

  it('finds the active task on a thread and ignores finished ones', () => {
    const s = store()
    s.createTask({ task_id: 'aaaaaaaa', thread_id: 'thr1', agent: 'backend', state: 'done' })
    expect(s.getActiveTaskByThread('thr1')).toBeUndefined()
    expect(s.getLatestTaskByThread('thr1')?.task_id).toBe('aaaaaaaa')
    s.createTask({ task_id: 'bbbbbbbb', thread_id: 'thr1', agent: 'backend', state: 'awaiting-human' })
    expect(s.getActiveTaskByThread('thr1')?.task_id).toBe('bbbbbbbb')
    s.close()
  })

  it('accumulates spend and never goes backwards', () => {
    const s = store()
    s.createTask({ task_id: 'aaaaaaaa', agent: 'backend' })
    expect(s.addSpend('aaaaaaaa', 1.25)).toBeCloseTo(1.25)
    expect(s.addSpend('aaaaaaaa', 0.75)).toBeCloseTo(2)
    expect(s.addSpend('aaaaaaaa', -5)).toBeCloseTo(2)
    s.close()
  })

  it('lists by state', () => {
    const s = store()
    s.createTask({ task_id: 'aaaaaaaa', agent: 'a', state: 'running' })
    s.createTask({ task_id: 'bbbbbbbb', agent: 'b', state: 'failed' })
    expect(s.listTasks().length).toBe(2)
    expect(s.listTasks('failed').map((t) => t.task_id)).toEqual(['bbbbbbbb'])
    s.close()
  })

  it('ignores an empty patch', () => {
    const s = store()
    s.createTask({ task_id: 'aaaaaaaa', agent: 'a' })
    s.updateTask('aaaaaaaa', {})
    expect(s.getTask('aaaaaaaa')!.state).toBe('running')
    s.close()
  })
})

describe('sessions', () => {
  it('upserts each field independently', () => {
    const s = store()
    s.putSession('thr1', { session_id: 'sess-1' })
    s.putSession('thr1', { summary: 'did the thing' })
    expect(s.getSession('thr1')).toMatchObject({ session_id: 'sess-1', summary: 'did the thing' })
    s.putSession('thr1', { session_id: 'sess-2' })
    expect(s.getSession('thr1')!.summary).toBe('did the thing')
    s.close()
  })
})

describe('questions', () => {
  const seed = (s: Store): void => {
    s.createTask({ task_id: 'aaaaaaaa', thread_id: 'thr1', agent: 'backend' })
    s.createQuestion({
      question_id: 'q_aaaaaaaaaa',
      task_id: 'aaaaaaaa',
      asked_email: 'Ada@example.com',
      state: 'pending-permission',
      file: 'src/retry.ts',
      line_start: 40,
      line_end: 44,
      question: 'why 3?',
    })
  }

  it('normalizes the address and round-trips', () => {
    const s = store()
    seed(s)
    expect(s.getQuestion('q_aaaaaaaaaa')!.asked_email).toBe('ada@example.com')
    s.close()
  })

  it('finds by thread and state', () => {
    const s = store()
    seed(s)
    expect(s.findQuestionsByThread('thr1', 'pending-permission').length).toBe(1)
    expect(s.findQuestionsByThread('thr1', 'sent').length).toBe(0)
    s.updateQuestion('q_aaaaaaaaaa', { state: 'sent' })
    expect(s.findSentQuestionFrom('ADA@example.com')!.question_id).toBe('q_aaaaaaaaaa')
    s.close()
  })

  it('lists per task, optionally by state', () => {
    const s = store()
    seed(s)
    expect(s.listQuestions('aaaaaaaa').length).toBe(1)
    expect(s.listQuestions('aaaaaaaa', 'sent').length).toBe(0)
    s.close()
  })

  it('ignores an empty patch', () => {
    const s = store()
    seed(s)
    s.updateQuestion('q_aaaaaaaaaa', {})
    expect(s.getQuestion('q_aaaaaaaaaa')!.state).toBe('pending-permission')
    s.close()
  })
})

describe('outreach budget (§6.3)', () => {
  it('counts per person per week', () => {
    const s = store()
    expect(s.outreachCount('ada@example.com')).toBe(0)
    expect(s.bumpOutreach('Ada@example.com')).toBe(1)
    expect(s.bumpOutreach('ada@example.com')).toBe(2)
    expect(s.outreachCount('ADA@example.com')).toBe(2)
    expect(s.outreachCount('ada@example.com', '1999-W01')).toBe(0)
    s.close()
  })
})

describe('cursors (§11 backlog recovery)', () => {
  it('only moves forward', () => {
    const s = store()
    expect(s.getCursor('backend@agentmail.to')).toBeUndefined()
    s.setCursor('backend@agentmail.to', 1000)
    s.setCursor('backend@agentmail.to', 500)
    expect(s.getCursor('backend@agentmail.to')).toBe(1000)
    s.setCursor('backend@agentmail.to', 2000)
    expect(s.getCursor('backend@agentmail.to')).toBe(2000)
    s.close()
  })
})

describe('reset', () => {
  it('clears history but leaves cursors alone', () => {
    const s = store()
    s.createTask({ task_id: 'aaaaaaaa', thread_id: 'thr1', agent: 'backend' })
    s.createQuestion({
      question_id: 'q_aaaaaaaaaa',
      task_id: 'aaaaaaaa',
      asked_email: 'ada@example.com',
      state: 'sent',
      question: 'why?',
    })
    s.markSeen('m1')
    s.putSession('thr1', { session_id: 'sess-1' })
    s.bumpOutreach('ada@example.com')
    s.claimNotice('aaaaaaaa', 'hop-limit')
    s.setCursor('backend@agentmail.to', 5000)

    const counts = s.clearAll()
    expect(counts).toEqual({ tasks: 1, seen: 1, questions: 1 })
    expect(s.listTasks()).toEqual([])
    expect(s.hasSeen('m1')).toBe(false)
    expect(s.getQuestion('q_aaaaaaaaaa')).toBeUndefined()
    expect(s.getSession('thr1')).toBeUndefined()
    expect(s.outreachCount('ada@example.com')).toBe(0)
    expect(s.claimNotice('aaaaaaaa', 'hop-limit')).toBe(true)

    // Cursors survive clearAll: dropping them would make the next run replay
    // the entire mailbox, which is the opposite of a clean slate.
    expect(s.getCursor('backend@agentmail.to')).toBe(5000)
    s.close()
  })

  it('forceCursor moves a cursor backwards, which setCursor refuses to do', () => {
    const s = store()
    s.setCursor('backend@agentmail.to', 5000)
    s.setCursor('backend@agentmail.to', 1000)
    expect(s.getCursor('backend@agentmail.to')).toBe(5000)
    s.forceCursor('backend@agentmail.to', 1000)
    expect(s.getCursor('backend@agentmail.to')).toBe(1000)
    s.close()
  })
})

describe('notices (§5.5 once per task)', () => {
  it('claims once', () => {
    const s = store()
    expect(s.claimNotice('aaaaaaaa', 'hop-limit')).toBe(true)
    expect(s.claimNotice('aaaaaaaa', 'hop-limit')).toBe(false)
    expect(s.claimNotice('aaaaaaaa', 'other')).toBe(true)
    s.close()
  })
})
