import { describe, it, expect } from 'vitest'
import { runConcurrent } from './backfill-pool'

describe('runConcurrent', () => {
  it('returns results in input order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1]
    const out = await runConcurrent(
      delays,
      async (d, i) => {
        await new Promise((r) => setTimeout(r, d))
        return i
      },
      2,
    )
    expect(out).toEqual([0, 1, 2, 3])
  })

  it('never exceeds the concurrency cap', async () => {
    let active = 0
    let maxActive = 0
    await runConcurrent(
      Array.from({ length: 12 }, (_, i) => i),
      async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return null
      },
      3,
    )
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('passes the item and its index to the worker', async () => {
    const out = await runConcurrent(['a', 'b', 'c'], async (item, i) => `${i}:${item}`, 5)
    expect(out).toEqual(['0:a', '1:b', '2:c'])
  })

  it('returns an empty array for empty input', async () => {
    expect(await runConcurrent([], async () => 1, 5)).toEqual([])
  })
})
