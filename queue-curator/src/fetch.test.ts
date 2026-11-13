// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { fetchAllByKey } from './fetch'

describe('fetchAllByKey', () => {
  it('pages by id and stops only on an empty page', async () => {
    const sizes = [1000, 1000, 337, 0]
    const calls: [number, number][] = []
    let next = 1
    const rows = await fetchAllByKey(async (afterId, limit) => {
      calls.push([afterId, limit])
      return { data: Array.from({ length: sizes.shift() ?? 0 }, () => ({ id: next++ * 2 })), error: null }
    })
    expect(rows).toHaveLength(2337)
    expect(calls).toEqual([[0, 1000], [2000, 1000], [4000, 1000], [4674, 1000]])
  })

  it('keeps going after a short page (a lower server row limit)', async () => {
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []]
    const rows = await fetchAllByKey(async () => ({ data: pages.shift() ?? [], error: null }), 1000)
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('throws on a page error', async () => {
    await expect(fetchAllByKey(async () => ({ data: null, error: { message: 'boom' } }))).rejects.toThrow(/boom/)
  })
})

