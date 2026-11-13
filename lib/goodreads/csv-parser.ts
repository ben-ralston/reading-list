// Goodreads CSV → SyncItem[] mapper (#147, Task 7).
//
// Parses the CSV produced by Goodreads' "Export Library" flow (My Books →
// Import/Export → Export Library). Goodreads CSVs follow RFC 4180 closely
// enough that a small purpose-built parser handles them; introducing a
// CSV dependency for one feature isn't worth the weight. The parser
// supports:
//   - Comma-separated values with optional double-quote wrapping
//   - Embedded "" → " inside quoted values
//   - Embedded commas and CRLF inside quoted values
//   - Goodreads' "=\"value\"" ISBN quirk (a leading = to make Excel/Sheets
//     treat the field as text). We strip it.
//
// Column mapping (only the columns we use; everything else is ignored):
//   Book Id            → externalId: 'goodreads:book:<id>', source link
//   Title              → title  (required; row dropped if missing)
//   Author             → author (required; row dropped if missing)
//   Year Published     → publishedOn (Jan 1 of year, noon UTC)
//   Exclusive Shelf    → status: '' | 'In Progress' | 'Completed'
//   Date Read          → statusChangedAt (only set when status='Completed')
//
// All emitted items get kind='book' and platform='Goodreads'.

import type { SyncItem } from '@/lib/sync/matching'

export interface GoodreadsImportResult {
  items: SyncItem[]
  /** Rows skipped during parsing, with a one-line reason each. */
  skipped: Array<{ row: number; reason: string }>
}

const SOURCE_PLATFORM = 'Goodreads'

// --- low-level CSV parsing ---------------------------------------------------

/**
 * Parse a CSV string into a 2D array of cells. Tolerates `\r\n` and `\n` line
 * endings, double-quoted fields (with `""` escape), and trailing whitespace.
 * Returns empty array on empty input.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  let inQuotes = false

  while (i < input.length) {
    const ch = input[i]

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        cell += ch
        i++
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(cell)
      cell = ''
      i++
      continue
    }
    if (ch === '\r') {
      // Eat \r and \r\n alike; the \n branch finalizes the row.
      i++
      continue
    }
    if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
      continue
    }
    cell += ch
    i++
  }

  // Final field/row — but skip an entirely empty trailing line.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  return rows
}

// --- Goodreads-specific transformations --------------------------------------

/**
 * Strip Goodreads' Excel-safety prefix from fields like `="0140449140"`.
 *
 * In the raw CSV byte stream the cell is `="…"` — an unquoted `=` followed
 * by a quoted text. After parseCsv() runs, the surrounding quotes have
 * already been consumed, so the parsed value is `=<content>`. We just strip
 * the leading `=` (and tolerate the original literal-quoted form too, in
 * case it's ever passed in pre-parsed).
 */
function stripExcelPrefix(s: string): string {
  if (s.startsWith('="') && s.endsWith('"')) return s.slice(2, -1)
  if (s.startsWith('=')) return s.slice(1)
  return s
}

function trimToNull(s: string | undefined): string | null {
  if (s === undefined) return null
  const t = s.trim()
  return t.length === 0 ? null : t
}

/** Parse `YYYY/MM/DD` or `YYYY-MM-DD` to an ISO string at noon UTC, or null. */
function parseGoodreadsDate(s: string | null): string | null {
  if (!s) return null
  // Goodreads uses YYYY/MM/DD by default; tolerate YYYY-MM-DD too.
  const m = s.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
  if (!m) return null
  const year = parseInt(m[1], 10)
  const month = parseInt(m[2], 10)
  const day = parseInt(m[3], 10)
  if (!year || !month || !day) return null
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parseYearPublished(s: string | null): string | null {
  if (!s) return null
  const m = s.trim().match(/^(-?\d{1,4})$/)
  if (!m) return null
  const year = parseInt(m[1], 10)
  if (!year) return null
  // Jan 1 noon UTC — matches how the rest of the codebase stores publish dates.
  const date = new Date(Date.UTC(year, 0, 1, 12, 0, 0))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

interface ShelfMapping {
  status: '' | 'In Progress' | 'Completed' | 'Skip'
}

function shelfMapping(rawShelf: string | null): ShelfMapping | null {
  const shelf = (rawShelf ?? '').trim().toLowerCase()
  if (!shelf) return { status: '' }
  if (shelf === 'to-read') return { status: '' }
  if (shelf === 'currently-reading') return { status: 'In Progress' }
  if (shelf === 'read') return { status: 'Completed' }
  // Anything else (custom shelves) — skip in v1 rather than guess.
  return null
}

/**
 * Convert a parsed Goodreads CSV (header row + data rows) into SyncItems.
 * Drops rows with no title or no author (returns them in `skipped`).
 */
export function rowsToSyncItems(rows: string[][]): GoodreadsImportResult {
  const items: SyncItem[] = []
  const skipped: Array<{ row: number; reason: string }> = []

  if (rows.length === 0) return { items, skipped }

  const header = rows[0].map((h) => h.trim())
  const idx = (name: string): number => header.indexOf(name)

  const cTitle = idx('Title')
  const cAuthor = idx('Author')
  const cBookId = idx('Book Id')
  const cYear = idx('Year Published')
  const cShelf = idx('Exclusive Shelf')
  const cDateRead = idx('Date Read')

  if (cTitle === -1 || cAuthor === -1) {
    // No usable schema — surface as a single skipped row so the caller can
    // report something meaningful.
    skipped.push({ row: 0, reason: "CSV header missing 'Title' or 'Author' column" })
    return { items, skipped }
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    // Skip empty trailing rows the parser may have emitted.
    if (row.length === 1 && row[0].trim() === '') continue

    const title = trimToNull(row[cTitle])
    const author = trimToNull(row[cAuthor])
    if (!title) {
      skipped.push({ row: r, reason: 'missing title' })
      continue
    }
    if (!author) {
      skipped.push({ row: r, reason: 'missing author' })
      continue
    }

    const rawShelf = cShelf >= 0 ? trimToNull(row[cShelf]) : null
    const mapping = shelfMapping(rawShelf)
    if (!mapping) {
      skipped.push({ row: r, reason: `unknown Exclusive Shelf: ${rawShelf}` })
      continue
    }

    const bookId = cBookId >= 0 ? stripExcelPrefix(trimToNull(row[cBookId]) ?? '') : ''
    const externalId = bookId ? `goodreads:book:${bookId}` : undefined
    const link = bookId ? `https://www.goodreads.com/book/show/${bookId}` : ''

    const publishedOn = parseYearPublished(cYear >= 0 ? trimToNull(row[cYear]) : null)
    const dateRead =
      mapping.status === 'Completed'
        ? parseGoodreadsDate(cDateRead >= 0 ? trimToNull(row[cDateRead]) : null)
        : null

    const item: SyncItem = {
      title,
      author,
      platform: SOURCE_PLATFORM,
      link,
      kind: 'book',
      externalId,
      publishedOn: publishedOn ?? undefined,
    }

    if (mapping.status === 'In Progress' || mapping.status === 'Completed') {
      item.status = mapping.status
    }
    if (dateRead) {
      item.statusChangedAt = dateRead
    }

    items.push(item)
  }

  return { items, skipped }
}

/** Convenience: end-to-end parser. */
export function parseGoodreadsCsv(input: string): GoodreadsImportResult {
  return rowsToSyncItems(parseCsv(input))
}

// Exported for unit tests; kept off the main public surface.
export const _internal = {
  stripExcelPrefix,
  parseGoodreadsDate,
  parseYearPublished,
  shelfMapping,
}
