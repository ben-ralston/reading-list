import { describe, it, expect } from 'vitest'
import type { QueueItem } from './queue-client'
import {
  UNKNOWN_AUTHOR_LABEL,
  authorKey,
  buildAuthorOptions,
  matchesAuthorFilter,
} from './author-filter'

// Minimal item factory — only `author` matters to the author filter.
function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    title: 'Test Item',
    author: 'Test Author',
    publishedOn: null,
    status: '',
    queuePosition: 1,
    positionConfirmed: true,
    progress: null,
    addedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    statusChangedAt: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 1, platform: 'Substack', link: 'https://example.com/a', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
    ],
    platform: 'Substack',
    link: 'https://example.com/a',
    ...overrides,
  }
}

describe('authorKey', () => {
  it('normalizes by trimming and lowercasing', () => {
    expect(authorKey('Jane Doe')).toBe('jane doe')
    expect(authorKey('  jane DOE  ')).toBe('jane doe')
  })

  it('maps empty and whitespace-only authors to the empty key', () => {
    expect(authorKey('')).toBe('')
    expect(authorKey('   ')).toBe('')
  })

  it('maps a literal "Unknown" author string to the empty key', () => {
    // Parsers write the string "Unknown" when they cannot determine an
    // author (observed in prod), so it IS the unknown bucket — otherwise
    // selecting the "Unknown" option (which maps to the empty key) would
    // never match these items.
    expect(authorKey('Unknown')).toBe('')
    expect(authorKey(' unknown ')).toBe('')
  })
})

describe('buildAuthorOptions', () => {
  it('lists distinct authors with counts, sorted alphabetically (case-insensitive)', () => {
    const options = buildAuthorOptions(
      [
        makeItem({ id: 1, author: 'zvi mowshowitz' }),
        makeItem({ id: 2, author: 'Matt Levine' }),
        makeItem({ id: 3, author: 'Matt Levine' }),
      ],
      [],
    )
    expect(options).toEqual([
      { key: 'matt levine', label: 'Matt Levine', count: 2 },
      { key: 'zvi mowshowitz', label: 'zvi mowshowitz', count: 1 },
    ])
  })

  it('merges case/whitespace variants into one option with first-seen trimmed casing', () => {
    const options = buildAuthorOptions(
      [
        makeItem({ id: 1, author: 'Jane Doe' }),
        makeItem({ id: 2, author: 'jane doe ' }),
      ],
      [],
    )
    expect(options).toEqual([{ key: 'jane doe', label: 'Jane Doe', count: 2 }])
  })

  it('buckets empty and whitespace-only authors as Unknown, pinned last', () => {
    const options = buildAuthorOptions(
      [
        makeItem({ id: 1, author: '' }),
        makeItem({ id: 2, author: '  ' }),
        makeItem({ id: 3, author: 'Ada Lovelace' }),
      ],
      [],
    )
    expect(options).toEqual([
      { key: 'ada lovelace', label: 'Ada Lovelace', count: 1 },
      { key: '', label: UNKNOWN_AUTHOR_LABEL, count: 2 },
    ])
  })

  it('merges literal "Unknown" authors into the pinned Unknown bucket', () => {
    const options = buildAuthorOptions(
      [
        makeItem({ id: 1, author: 'Unknown' }),
        makeItem({ id: 2, author: '' }),
        makeItem({ id: 3, author: 'Zvi Mowshowitz' }),
      ],
      [],
    )
    expect(options).toEqual([
      { key: 'zvi mowshowitz', label: 'Zvi Mowshowitz', count: 1 },
      { key: '', label: UNKNOWN_AUTHOR_LABEL, count: 2 },
    ])
  })

  it('includes out-of-scope selected authors with count 0 (union)', () => {
    const options = buildAuthorOptions(
      [makeItem({ id: 1, author: 'Matt Levine' })],
      ['Ghost Writer'],
    )
    expect(options).toEqual([
      { key: 'ghost writer', label: 'Ghost Writer', count: 0 },
      { key: 'matt levine', label: 'Matt Levine', count: 1 },
    ])
  })

  it('keeps the selected label for a selected key even when scope casing differs', () => {
    // The user selected 'Jane Doe' earlier; the current scope's first-seen
    // casing is 'JANE DOE'. The selected label must win, or the checked state
    // (matched by label) would silently detach after a media-filter switch.
    const options = buildAuthorOptions(
      [makeItem({ id: 1, author: 'JANE DOE' })],
      ['Jane Doe'],
    )
    expect(options).toEqual([{ key: 'jane doe', label: 'Jane Doe', count: 1 }])
  })

  it('includes a selected Unknown bucket even when no unknown items are in scope', () => {
    const options = buildAuthorOptions(
      [makeItem({ id: 1, author: 'Ada Lovelace' })],
      [UNKNOWN_AUTHOR_LABEL],
    )
    expect(options).toEqual([
      { key: 'ada lovelace', label: 'Ada Lovelace', count: 1 },
      { key: '', label: UNKNOWN_AUTHOR_LABEL, count: 0 },
    ])
  })
})

describe('matchesAuthorFilter', () => {
  it('matches everything when no authors are selected', () => {
    expect(matchesAuthorFilter(makeItem({ author: 'Anyone' }), [])).toBe(true)
    expect(matchesAuthorFilter(makeItem({ author: '' }), [])).toBe(true)
  })

  it('matches by normalized key, not exact string', () => {
    expect(matchesAuthorFilter(makeItem({ author: '  jane doe' }), ['Jane Doe'])).toBe(true)
    expect(matchesAuthorFilter(makeItem({ author: 'John Smith' }), ['Jane Doe'])).toBe(false)
  })

  it('matches any of several selected authors', () => {
    expect(matchesAuthorFilter(makeItem({ author: 'Ada Lovelace' }), ['Jane Doe', 'Ada Lovelace'])).toBe(true)
  })

  it('matches empty/whitespace authors via the Unknown selection', () => {
    expect(matchesAuthorFilter(makeItem({ author: '' }), [UNKNOWN_AUTHOR_LABEL])).toBe(true)
    expect(matchesAuthorFilter(makeItem({ author: '   ' }), [UNKNOWN_AUTHOR_LABEL])).toBe(true)
    expect(matchesAuthorFilter(makeItem({ author: 'Someone' }), [UNKNOWN_AUTHOR_LABEL])).toBe(false)
  })

  it('matches literal "Unknown" authors via the Unknown selection', () => {
    expect(matchesAuthorFilter(makeItem({ author: 'Unknown' }), [UNKNOWN_AUTHOR_LABEL])).toBe(true)
  })
})
