import { describe, it, expect } from 'vitest'
import { filterBySearch, hasSearchQuery, noSearchMatchesMessage, normalizeSearchQuery } from './search-filter'

const bitter = { title: 'The Bitter Lesson', author: 'Rich Sutton' }
const attention = { title: 'Attention Is All You Need', author: 'Vaswani' }
const items = [bitter, attention]
const titles = (q: string) => filterBySearch(items, q).map(i => i.title)

describe('normalizeSearchQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeSearchQuery('  Bitter ')).toBe('bitter')
  })
})

describe('noSearchMatchesMessage', () => {
  it('echoes the trimmed, case-preserved query', () => {
    expect(noSearchMatchesMessage('  Bitter ')).toBe('No items match "Bitter"')
  })
})

describe('hasSearchQuery', () => {
  it('is false for empty or whitespace-only queries and true otherwise', () => {
    expect(hasSearchQuery('')).toBe(false)
    expect(hasSearchQuery('   ')).toBe(false)
    expect(hasSearchQuery(' a ')).toBe(true)
  })
})

describe('filterBySearch', () => {
  it('returns the SAME array when the query is empty (preserves memo identity)', () => {
    expect(filterBySearch(items, '')).toBe(items)
    expect(filterBySearch(items, '  ')).toBe(items)
  })

  it('matches a case-insensitive substring of the title', () => {
    expect(titles('bitter')).toEqual(['The Bitter Lesson'])
    expect(titles('LESSON')).toEqual(['The Bitter Lesson'])
    expect(titles('sweet')).toEqual([])
  })

  it('matches a case-insensitive substring of the author', () => {
    expect(titles('sutton')).toEqual(['The Bitter Lesson'])
    expect(titles('VASWANI')).toEqual(['Attention Is All You Need'])
  })

  it('ignores leading/trailing whitespace in the query', () => {
    expect(titles('  bitter  ')).toEqual(['The Bitter Lesson'])
  })

  it('does not match across the title/author boundary', () => {
    // "lesson rich" would only match if title and author were concatenated.
    expect(titles('lesson rich')).toEqual([])
  })
})
