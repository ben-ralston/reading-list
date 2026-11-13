import { describe, it, expect, vi } from 'vitest'
import { regenerateAll } from './summary-regenerate'

const items = [
  { id: 1, title: 'One' },
  { id: 2, title: 'Two' },
  { id: 3, title: 'Three' },
]

describe('regenerateAll (#304)', () => {
  it('counts successes and continues past ordinary failures', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Summary output failed validation'))
      .mockResolvedValueOnce(undefined)
    const result = await regenerateAll(items, generate, { delayMs: 0, log: () => {} })
    expect(generate).toHaveBeenCalledTimes(3)
    expect(result).toEqual({
      ok: 1 + 1,
      failed: [{ id: 2, title: 'Two', error: 'Summary output failed validation' }],
      notAttempted: 0,
    })
  })

  it('stops on the account spend limit and reports the rest as not attempted', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('400 You have reached your specified API usage limits.'))
    const result = await regenerateAll(items, generate, { delayMs: 0, log: () => {} })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(1)
    expect(result.failed.map((f) => f.id)).toEqual([2])
    expect(result.notAttempted).toBe(1)
  })
})
