import { describe, expect, it } from 'vitest'
import * as envelope from '../src/envelope.js'

const TASK = 'abcdefgh'
const QUESTION = 'q_abcdefgh23'

describe('encodeHeaders', () => {
  it('always stamps the proto version', () => {
    expect(envelope.encodeHeaders({})).toEqual({ 'x-harness-proto': '1' })
  })

  it('emits every field when present', () => {
    expect(envelope.encodeHeaders({ taskId: TASK, hops: 2, inReplyToQuestion: QUESTION })).toEqual({
      'x-harness-proto': '1',
      'x-task-id': TASK,
      'x-hops': '2',
      'x-in-reply-to-question': QUESTION,
    })
  })

  it('clamps a negative or fractional hop count', () => {
    expect(envelope.encodeHeaders({ hops: -4 })['x-hops']).toBe('0')
    expect(envelope.encodeHeaders({ hops: 2.9 })['x-hops']).toBe('2')
  })
})

describe('encodeTrailer', () => {
  it('serialises the fields as a single final line', () => {
    const line = envelope.encodeTrailer({ taskId: TASK, hops: 3, inReplyToQuestion: QUESTION })
    expect(line.startsWith('-- harness: ')).toBe(true)
    expect(JSON.parse(line.slice('-- harness:'.length))).toEqual({
      proto: '1',
      task_id: TASK,
      hops: 3,
      in_reply_to_question: QUESTION,
    })
  })

  it('omits hops entirely when the caller does not supply one', () => {
    expect(JSON.parse(envelope.encodeTrailer({ taskId: TASK }).slice('-- harness:'.length))).toEqual({
      proto: '1',
      task_id: TASK,
    })
  })

  it('omits absent fields and clamps hops', () => {
    expect(JSON.parse(envelope.encodeTrailer({ hops: -1 }).slice('-- harness:'.length))).toEqual({
      proto: '1',
      hops: 0,
    })
  })
})

describe('encode', () => {
  it('headers mode leaves the body untouched', () => {
    const out = envelope.encode({ taskId: TASK, hops: 1 }, 'hello', 'headers')
    expect(out.text).toBe('hello')
    expect(out.headers['x-task-id']).toBe(TASK)
  })

  it('trailer mode moves the fields into the body', () => {
    const out = envelope.encode({ taskId: TASK, hops: 1 }, 'hello  \n\n', 'trailer')
    expect(out.headers).toEqual({})
    expect(out.text).toContain('-- harness: ')
    expect(envelope.parse(undefined, out.text).taskId).toBe(TASK)
  })

  it('both mode sets headers and the trailer', () => {
    const out = envelope.encode({ taskId: TASK, hops: 4 }, 'hello', 'both')
    expect(out.headers['x-hops']).toBe('4')
    expect(out.text).toContain('-- harness: ')
  })

  it('defaults to headers mode', () => {
    expect(envelope.encode({ hops: 0 }, 'body').text).toBe('body')
  })
})

describe('parse', () => {
  it('treats mail with no proto marker as human-authored', () => {
    const env = envelope.parse({}, 'just a person writing')
    expect(env).toEqual({ human: true, hops: 0 })
  })

  it('handles a missing headers object entirely', () => {
    expect(envelope.parse().human).toBe(true)
  })

  it('reads a full envelope, case-insensitively', () => {
    const env = envelope.parse({
      'X-Harness-Proto': '1',
      'X-Task-Id': TASK,
      'X-Hops': '3',
      'X-In-Reply-To-Question': QUESTION,
    })
    expect(env).toEqual({
      human: false,
      proto: '1',
      taskId: TASK,
      hops: 3,
      inReplyToQuestion: QUESTION,
    })
  })

  it("accepts SPEC's x-agent-protocol as an alias for the proto marker", () => {
    const env = envelope.parse({ 'x-agent-protocol': '1', 'x-task-id': TASK, 'x-hops': '2' })
    expect(env).toEqual({ human: false, proto: '1', taskId: TASK, hops: 2 })
  })

  it('prefers x-harness-proto when both spellings are present', () => {
    expect(envelope.parse({ 'x-harness-proto': '1', 'x-agent-protocol': '9' }).proto).toBe('1')
  })

  it('ignores non-string header values', () => {
    const env = envelope.parse({ 'x-harness-proto': 1 as unknown as string })
    expect(env.human).toBe(true)
  })

  it('degrades a malformed task id rather than throwing', () => {
    const env = envelope.parse({ 'x-harness-proto': '1', 'x-task-id': 'NOT A TASK ID' })
    expect(env.taskId).toBeUndefined()
    expect(env.human).toBe(false)
  })

  it('degrades a malformed question id', () => {
    const env = envelope.parse({ 'x-harness-proto': '1', 'x-in-reply-to-question': 'nope' })
    expect(env.inReplyToQuestion).toBeUndefined()
  })

  it.each([
    ['garbage', 0],
    ['', 0],
    ['-2', 0],
    ['4.8', 4],
  ])('reads hops %s as %i', (raw, expected) => {
    expect(envelope.parse({ 'x-hops': raw }).hops).toBe(expected)
  })

  it('treats a blank proto header as absent', () => {
    expect(envelope.parse({ 'x-harness-proto': '   ' }).human).toBe(true)
  })

  it('falls back to the trailer when headers are stripped (Q1)', () => {
    const body = `do the thing\n\n-- harness: {"proto":"1","task_id":"${TASK}","hops":2,"in_reply_to_question":"${QUESTION}"}`
    expect(envelope.parse({}, body)).toEqual({
      human: false,
      proto: '1',
      taskId: TASK,
      hops: 2,
      inReplyToQuestion: QUESTION,
    })
  })

  it('prefers headers over a disagreeing trailer', () => {
    const body = `x\n-- harness: {"proto":"1","hops":9}`
    expect(envelope.parse({ 'x-harness-proto': '1', 'x-hops': '1' }, body).hops).toBe(1)
  })

  it('ignores a malformed trailer', () => {
    expect(envelope.parse({}, 'text\n-- harness: {not json').human).toBe(true)
  })

  it('ignores a trailer that is not a JSON object', () => {
    expect(envelope.parse({}, 'text\n-- harness: [1,2,3]').human).toBe(true)
    expect(envelope.parse({}, 'text\n-- harness: "hi"').human).toBe(true)
  })

  it('ignores non-numeric hops in a trailer', () => {
    const env = envelope.parse({}, 'x\n-- harness: {"proto":"1","hops":"three"}')
    expect(env.hops).toBe(0)
  })

  it('clamps a negative hop count in a trailer', () => {
    expect(envelope.parse({}, 'x\n-- harness: {"proto":"1","hops":-3}').hops).toBe(0)
  })

  it('ignores non-string ids in a trailer', () => {
    const env = envelope.parse({}, 'x\n-- harness: {"proto":"1","task_id":7,"in_reply_to_question":9}')
    expect(env.taskId).toBeUndefined()
    expect(env.inReplyToQuestion).toBeUndefined()
  })

  it('ignores a non-string proto in a trailer', () => {
    expect(envelope.parse({}, 'x\n-- harness: {"proto":1}').human).toBe(true)
  })

  it('only looks at the last trailer-shaped line', () => {
    const body = `-- harness: {"proto":"1","hops":5}\nlater text`
    expect(envelope.parse({}, body).human).toBe(true)
  })

  it('handles a body with no trailer and no text', () => {
    expect(envelope.parse({}, '').human).toBe(true)
    expect(envelope.parse({}, undefined).human).toBe(true)
  })

  it('handles a whitespace-only body', () => {
    expect(envelope.parse({}, '   \n\n  \n').human).toBe(true)
  })

  it('handles CRLF bodies', () => {
    const body = `hi\r\n-- harness: {"proto":"1","hops":2}`
    expect(envelope.parse({}, body).hops).toBe(2)
  })
})

describe('stripTrailer', () => {
  it('removes the trailer and trailing whitespace', () => {
    expect(envelope.stripTrailer('body\n\n-- harness: {"proto":"1"}\n')).toBe('body')
  })

  it('leaves a body without a trailer alone', () => {
    expect(envelope.stripTrailer('body\n\nmore')).toBe('body\n\nmore')
  })

  it('handles an empty body', () => {
    expect(envelope.stripTrailer('')).toBe('')
  })

  it('leaves a trailer that is not the final line alone', () => {
    const body = '-- harness: {"proto":"1"}\nafter'
    expect(envelope.stripTrailer(body)).toBe(body)
  })
})
