import { describe, it, expect } from 'vitest'
import { chunk, SUPABASE_IN_CHUNK_SIZE } from './batch'

describe('chunk', () => {
  it('returns an empty array for an empty input', () => {
    expect(chunk([], 5)).toEqual([])
  })

  it('returns a single chunk when input is shorter than size', () => {
    expect(chunk(['a', 'b'], 5)).toEqual([['a', 'b']])
  })

  it('returns a single chunk when input length equals size', () => {
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]])
  })

  it('splits inputs larger than size into chunks with the remainder last', () => {
    expect(chunk(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('returns exactly two full chunks when input length is twice the size', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('throws when size is not a positive integer', () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow()
    expect(() => chunk([1, 2, 3], -1)).toThrow()
  })

  it('chunks 388 items into batches of 100 at SUPABASE_IN_CHUNK_SIZE=100', () => {
    expect(SUPABASE_IN_CHUNK_SIZE).toBe(100)
    const ids = Array.from({ length: 388 }, (_, i) => `id-${i}`)
    const result = chunk(ids, SUPABASE_IN_CHUNK_SIZE)
    expect(result).toHaveLength(4)
    expect(result[0]).toHaveLength(100)
    expect(result[1]).toHaveLength(100)
    expect(result[2]).toHaveLength(100)
    expect(result[3]).toHaveLength(88)
    expect(result.flat()).toEqual(ids)
  })
})
