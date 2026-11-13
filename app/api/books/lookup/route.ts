import { NextResponse } from 'next/server'
import { parseBook, type BookMetadata } from '@/lib/book-parser'

// POST /api/books/lookup
//
// Pure metadata lookup for the agentic "Add book" flow (#186). Takes
// { input: "<title / 'title author' / ISBN / book URL>" } and returns
// { metadata, confidence } — it does NOT write to the database. Creation stays
// solely in /api/add-entry (the single source of truth for dedup, smart
// positioning, and orphan cleanup), so the client decides what to do with the
// result: auto-save on high confidence, or show the editable form on low.
//
// parseBook never throws on a lookup failure (it degrades to a low-confidence
// stub), but the call is wrapped defensively so an unexpected error still yields
// a usable 200 the client can fall back from. Low confidence is a normal
// outcome, not an error — it is returned with status 200.

export async function POST(request: Request) {
  let input: string
  try {
    const body = await request.json()
    if (typeof body.input !== 'string' || !body.input.trim()) {
      return NextResponse.json({ error: 'input is required' }, { status: 400 })
    }
    input = body.input.trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  let metadata: BookMetadata
  try {
    metadata = await parseBook(input)
  } catch (err) {
    console.error('[Book Lookup] Unexpected lookup error:', err)
    metadata = { title: '', author: '', confidence: 'low' }
  }

  return NextResponse.json({ metadata, confidence: metadata.confidence })
}
