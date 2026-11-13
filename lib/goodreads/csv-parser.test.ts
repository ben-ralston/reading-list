import { describe, it, expect } from 'vitest'
import { parseCsv, parseGoodreadsCsv, _internal } from './csv-parser'

describe('parseCsv', () => {
  it('handles a simple two-row CSV', () => {
    const rows = parseCsv('Title,Author\nFoo,Bar\n')
    expect(rows).toEqual([
      ['Title', 'Author'],
      ['Foo', 'Bar'],
    ])
  })

  it('handles quoted fields with embedded commas', () => {
    const rows = parseCsv('Title,Author\n"Foo, Bar","Baz, Qux"\n')
    expect(rows).toEqual([
      ['Title', 'Author'],
      ['Foo, Bar', 'Baz, Qux'],
    ])
  })

  it('handles "" escapes inside quoted fields', () => {
    const rows = parseCsv('Title\n"Say ""hello"""\n')
    expect(rows).toEqual([['Title'], ['Say "hello"']])
  })

  it('handles CRLF line endings', () => {
    const rows = parseCsv('a,b\r\nc,d\r\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('handles embedded newlines inside quoted fields', () => {
    const rows = parseCsv('Title,Author\n"Line 1\nLine 2",Smith\n')
    expect(rows).toEqual([
      ['Title', 'Author'],
      ['Line 1\nLine 2', 'Smith'],
    ])
  })

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([])
  })
})

describe('Goodreads field helpers', () => {
  it('strips Goodreads Excel-safety prefix from ISBN-like fields', () => {
    // Literal `="…"` form (matches the original CSV cell pre-parse).
    expect(_internal.stripExcelPrefix('="0140449140"')).toBe('0140449140')
    // Post-parse form: parseCsv has already consumed the surrounding quotes
    // and leaves `=0140449140` as the cell value.
    expect(_internal.stripExcelPrefix('=0140449140')).toBe('0140449140')
    // Leaves unprefixed values alone.
    expect(_internal.stripExcelPrefix('0140449140')).toBe('0140449140')
    expect(_internal.stripExcelPrefix('')).toBe('')
  })

  it('parses Goodreads YYYY/MM/DD dates to noon-UTC ISO', () => {
    expect(_internal.parseGoodreadsDate('2024/03/15')).toBe('2024-03-15T12:00:00.000Z')
    expect(_internal.parseGoodreadsDate('2024-03-15')).toBe('2024-03-15T12:00:00.000Z')
    expect(_internal.parseGoodreadsDate('')).toBeNull()
    expect(_internal.parseGoodreadsDate('not-a-date')).toBeNull()
  })

  it('parses Year Published to Jan 1 noon-UTC ISO', () => {
    expect(_internal.parseYearPublished('2014')).toBe('2014-01-01T12:00:00.000Z')
    expect(_internal.parseYearPublished('')).toBeNull()
    expect(_internal.parseYearPublished('garbage')).toBeNull()
  })

  it('maps Exclusive Shelf values', () => {
    expect(_internal.shelfMapping('to-read')).toEqual({ status: '' })
    expect(_internal.shelfMapping('currently-reading')).toEqual({ status: 'In Progress' })
    expect(_internal.shelfMapping('read')).toEqual({ status: 'Completed' })
    expect(_internal.shelfMapping('')).toEqual({ status: '' })
    expect(_internal.shelfMapping(null)).toEqual({ status: '' })
    // Custom shelves are skipped (returns null) so the caller can surface
    // them as "unknown" rather than silently misclassify.
    expect(_internal.shelfMapping('owned')).toBeNull()
  })
})

describe('parseGoodreadsCsv', () => {
  // A trimmed Goodreads-shaped CSV (only the columns we actually use, plus
  // a few alongside to make sure the by-name header lookup keeps working
  // when Goodreads' real export includes more columns than we need).
  const SAMPLE = `Book Id,Title,Author,Year Published,Date Read,Exclusive Shelf,My Rating
="11468377","Thinking, Fast and Slow","Daniel Kahneman",2011,2024/01/15,read,5
="9780670022472","Sapiens: A Brief History of Humankind","Yuval Noah Harari",2014,,currently-reading,
="9780812981605","The Hard Thing About Hard Things","Ben Horowitz",2014,,to-read,
`

  it('maps each row to a SyncItem with kind=book and Goodreads platform', () => {
    const { items, skipped } = parseGoodreadsCsv(SAMPLE)
    expect(skipped).toEqual([])
    expect(items).toHaveLength(3)
    for (const item of items) {
      expect(item.kind).toBe('book')
      expect(item.platform).toBe('Goodreads')
      expect(item.link).toContain('goodreads.com/book/show/')
    }
  })

  it('maps the three Exclusive Shelf values to status correctly', () => {
    const { items } = parseGoodreadsCsv(SAMPLE)
    const read = items.find((i) => i.title === 'Thinking, Fast and Slow')!
    const reading = items.find((i) => i.title.startsWith('Sapiens'))!
    const wantToRead = items.find((i) => i.title.startsWith('The Hard Thing'))!
    expect(read.status).toBe('Completed')
    expect(reading.status).toBe('In Progress')
    expect(wantToRead.status).toBeUndefined()
  })

  it('sets statusChangedAt only for read books', () => {
    const { items } = parseGoodreadsCsv(SAMPLE)
    const read = items.find((i) => i.title === 'Thinking, Fast and Slow')!
    const reading = items.find((i) => i.title.startsWith('Sapiens'))!
    expect(read.statusChangedAt).toBe('2024-01-15T12:00:00.000Z')
    expect(reading.statusChangedAt).toBeUndefined()
  })

  it('builds externalId from Book Id, stripping the Excel prefix', () => {
    const { items } = parseGoodreadsCsv(SAMPLE)
    const read = items.find((i) => i.title === 'Thinking, Fast and Slow')!
    expect(read.externalId).toBe('goodreads:book:11468377')
    expect(read.link).toBe('https://www.goodreads.com/book/show/11468377')
  })

  it('parses Year Published into Jan-1-noon-UTC publishedOn', () => {
    const { items } = parseGoodreadsCsv(SAMPLE)
    const sapiens = items.find((i) => i.title.startsWith('Sapiens'))!
    expect(sapiens.publishedOn).toBe('2014-01-01T12:00:00.000Z')
  })

  it('skips rows with missing title or author', () => {
    const csv = `Title,Author\n,Some Author\nA Book,\nGood Book,Real Author\n`
    const { items, skipped } = parseGoodreadsCsv(csv)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Good Book')
    expect(skipped).toEqual([
      { row: 1, reason: 'missing title' },
      { row: 2, reason: 'missing author' },
    ])
  })

  it('skips rows with unknown Exclusive Shelf values', () => {
    const csv = `Title,Author,Exclusive Shelf\nA Book,Some Author,owned\n`
    const { items, skipped } = parseGoodreadsCsv(csv)
    expect(items).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toContain('owned')
  })

  it('surfaces an error when the header is missing required columns', () => {
    const csv = `Foo,Bar\nbaz,qux\n`
    const { items, skipped } = parseGoodreadsCsv(csv)
    expect(items).toEqual([])
    expect(skipped[0].reason).toMatch(/Title.*Author/)
  })

  it('preserves unicode titles and authors', () => {
    const csv = `Title,Author\n"鋼の錬金術師","荒川弘"\n`
    const { items, skipped } = parseGoodreadsCsv(csv)
    expect(skipped).toEqual([])
    expect(items[0].title).toBe('鋼の錬金術師')
    expect(items[0].author).toBe('荒川弘')
  })

  it('tolerates CRLF line endings', () => {
    const csv = `Title,Author\r\nGreat Book,An Author\r\n`
    const { items } = parseGoodreadsCsv(csv)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Great Book')
  })

  it('handles a completely empty file gracefully', () => {
    expect(parseGoodreadsCsv('')).toEqual({ items: [], skipped: [] })
  })
})
