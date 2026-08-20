import { describe, expect, it } from 'vitest'
import { ThreadQueue, backoffMs } from '../src/daemon.js'

describe('backoffMs (§0: 1s → 60s, jitter)', () => {
  it('doubles from 1s and caps at 60s', () => {
    const noJitter = (): number => 0.5
    expect(backoffMs(0, noJitter)).toBe(1_000)
    expect(backoffMs(1, noJitter)).toBe(2_000)
    expect(backoffMs(4, noJitter)).toBe(16_000)
    expect(backoffMs(10, noJitter)).toBe(60_000)
    expect(backoffMs(100, noJitter)).toBe(60_000)
  })

  it('applies ±25% jitter and never dips below the floor', () => {
    expect(backoffMs(3, () => 0)).toBe(6_000) // 8s − 25%
    expect(backoffMs(3, () => 1)).toBe(10_000) // 8s + 25%
    expect(backoffMs(0, () => 0)).toBe(1_000)
  })

  it('treats a negative attempt as the first', () => {
    expect(backoffMs(-5, () => 0.5)).toBe(1_000)
  })
})

describe('ThreadQueue (§11: serial per thread, parallel across threads)', () => {
  const defer = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('never runs two jobs on one thread at once', async () => {
    const q = new ThreadQueue(3)
    const order: string[] = []
    const first = defer()

    const a = q.submit('thr1', async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
      return 'a'
    })
    const b = q.submit('thr1', async () => {
      order.push('b:start')
      return 'b'
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['a:start'])
    first.resolve()
    expect(await a).toBe('a')
    expect(await b).toBe('b')
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('runs different threads concurrently', async () => {
    const q = new ThreadQueue(3)
    const running: string[] = []
    const gate = defer()
    const jobs = ['t1', 't2', 't3'].map((t) =>
      q.submit(t, async () => {
        running.push(t)
        await gate.promise
        return t
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(running.sort()).toEqual(['t1', 't2', 't3'])
    gate.resolve()
    expect(await Promise.all(jobs)).toEqual(['t1', 't2', 't3'])
  })

  it('honours the concurrency limit', async () => {
    const q = new ThreadQueue(2)
    let active = 0
    let peak = 0
    const gate = defer()
    const jobs = ['a', 'b', 'c', 'd'].map((t) =>
      q.submit(t, async () => {
        active++
        peak = Math.max(peak, active)
        await gate.promise
        active--
        return t
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(peak).toBe(2)
    gate.resolve()
    await Promise.all(jobs)
    expect(peak).toBe(2)
  })

  it('surfaces a rejection without stalling the thread behind it', async () => {
    const q = new ThreadQueue(2)
    const failing = q.submit('thr1', async () => {
      throw new Error('boom')
    })
    const after = q.submit('thr1', async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    expect(await after).toBe('ok')
  })

  it('drains', async () => {
    const q = new ThreadQueue(2)
    const results: string[] = []
    for (const t of ['a', 'b', 'a']) {
      void q.submit(t, async () => {
        await new Promise((r) => setTimeout(r, 5))
        results.push(t)
      })
    }
    expect(q.idle).toBe(false)
    await q.drain()
    expect(q.idle).toBe(true)
    expect(results.length).toBe(3)
  })
})
