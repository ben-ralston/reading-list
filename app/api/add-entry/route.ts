import { timingSafeEqual } from 'crypto'
import { NextResponse, after } from 'next/server'
import { parseEntry, isDegenerateTitle, isUrl } from '@/lib/entry-parser'
import { generateSummary } from '@/lib/summary'
import { supabase } from '@/lib/supabase'
import {
  findMatchingContent,
  createContent,
  type SyncItem,
} from '@/lib/sync/matching'
import { logError } from '@/lib/logger'
import { pinContentItem } from '@/lib/content/shortlist-writes'

// POST /api/add-entry
//
// Two input shapes are accepted:
//
//  1. Free-form (existing — used by AddEntryDialog on the feed page):
//     { input: "https://… or 'Article Name + Substack'" }
//     The string is run through parseEntry to derive title/author/platform/link.
//
//  2. Structured (added for #147 — used by AddBookDialog on /books):
//     { kind: 'book', title, author, platform, link?: string | null }
//     Structured fields skip the parser. `link` may be null/empty for
//     Physical / Library / Other formats.
//
// The route is non-idempotent (POST creates a new content item) and uses
// the same matching+upsert path as the sync routes, so dedup-by-title+author
// applies. kind is forwarded to insert_or_update_content (INSERT-only —
// existing items' kind is never overwritten).
//
// Auth (#191): the route governs its own auth (it is excluded from the
// middleware cookie gate) so the iOS Share Sheet Shortcut can reach it from
// outside a browser session. It accepts EITHER a valid `_auth` session cookie
// (browser + button) OR a `Authorization: Bearer ${SHARE_API_SECRET}` header
// (the Shortcut). Mirrors the dual-auth pattern in app/api/cron/*, with the
// timing-safe secret comparison from app/api/sync (this route is reachable
// without a cookie by design, so the bearer check must not leak match length
// via response timing).

async function isAuthenticated(request: Request): Promise<boolean> {
  const authHeader = request.headers.get('authorization')
  const apiSecret = process.env.SHARE_API_SECRET
  if (authHeader && apiSecret) {
    const provided = Buffer.from(authHeader)
    const expected = Buffer.from(`Bearer ${apiSecret}`)
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true
  }
  try {
    const { getSession } = await import('@/lib/auth')
    const session = await getSession()
    if (session.isAuthenticated) return true
  } catch (err) {
    // getSession() returns an empty (unauthenticated) session for callers with
    // no cookie — it does NOT throw for that case. So reaching here means a real
    // failure: a misconfigured/rotated AUTH_PASSWORD_SECRET or an undecryptable
    // _auth cookie. Fail closed, but leave a breadcrumb — otherwise a legit
    // signed-in user with a stale cookie gets an unexplained 401.
    console.error('[Add Entry] Session validation failed:', err)
  }
  return false
}

// #191: when enrichment can't read a shared URL, save a minimal item instead of
// erroring. The raw URL is the visible "needs cleanup" title; the hostname
// (www stripped) satisfies the DB RPC's non-empty author/platform constraint.
function rawFallbackEntry(url: string) {
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    // Non-parseable URL — fall through to the raw-string stand-in below.
  }
  // `http://www.` parses but leaves an empty host after stripping "www."; the DB
  // RPC rejects an empty author/platform, so fall back to the raw URL string —
  // keeps the "a shared link never silently fails" guarantee for that edge.
  if (!host) host = url
  return { title: url, author: host, platform: host, link: url }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // --- Parse + validate the request body ---------------------------------
  let parsed: SyncItem
  // #191: set when enrichment failed but we saved a raw URL anyway — the
  // response flags it and the background summary is skipped (no real content).
  let isFallback = false
  try {
    const body = await request.json()

    if (typeof body.title === 'string' && typeof body.author === 'string' && typeof body.platform === 'string') {
      // Structured path
      if (!body.title.trim() || !body.author.trim() || !body.platform.trim()) {
        return NextResponse.json(
          { error: 'title, author, and platform are required' },
          { status: 400 },
        )
      }
      parsed = {
        title: body.title.trim(),
        author: body.author.trim(),
        platform: body.platform.trim(),
        link: typeof body.link === 'string' ? body.link.trim() || null : null,
        manuallyRequested: true,
        kind: body.kind === 'book' ? 'book' : 'feed',
        // Agentic book metadata (#186) — all optional, default null. The cover
        // rides the existing imageUrl → p_image_url path; subtitle/series/isbn13
        // are INSERT-only on content_items.
        subtitle: typeof body.subtitle === 'string' ? body.subtitle.trim() || null : null,
        series: typeof body.series === 'string' ? body.series.trim() || null : null,
        isbn13: typeof body.isbn13 === 'string' ? body.isbn13.trim() || null : null,
        imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl.trim() || null : null,
        publishedOn:
          typeof body.publishedOn === 'string' && body.publishedOn ? body.publishedOn : undefined,
      }
    } else if (typeof body.input === 'string' && body.input.trim()) {
      // Free-form path. The metadata fetch (fetch the URL / ask Claude) can
      // fail independently of the DB write, so it gets its own error stage so
      // the user sees "couldn't read the link" rather than a generic save
      // error (#176).
      const input = body.input.trim()
      // #191: the iOS Share Sheet Shortcut sets saveRawOnFailure so a shared
      // link never silently fails — if enrichment can't read the URL we save a
      // minimal raw item for manual cleanup instead of returning an error. Only
      // URL input can fall back (a failed text search has nothing to save).
      const canFallBack = body.saveRawOnFailure === true && isUrl(input)

      let parsedEntry
      try {
        parsedEntry = await parseEntry(input)
      } catch (err) {
        console.error('[Add Entry] Metadata fetch failed:', err)
        if (!canFallBack) {
          return NextResponse.json(
            {
              error: "Couldn't read that link — it didn't respond or its details couldn't be read.",
              stage: 'metadata',
            },
            { status: 502 },
          )
        }
        parsedEntry = rawFallbackEntry(input)
        isFallback = true
      }
      if (!isFallback && (!parsedEntry.title || isDegenerateTitle(parsedEntry.title))) {
        // A junk title (e.g. the "- YouTube" bot-wall page title) must not
        // reach the DB: persisting it once creates an invisible dedup magnet
        // every later failed extraction matches as "already in your list" (#176).
        if (!canFallBack) {
          return NextResponse.json(
            { error: 'Could not extract a title from that link.', stage: 'metadata' },
            { status: 422 },
          )
        }
        parsedEntry = rawFallbackEntry(input)
        isFallback = true
      }
      if (!isFallback && !parsedEntry.link) {
        if (!canFallBack) {
          return NextResponse.json(
            { error: 'Could not find a link for this content.', stage: 'metadata' },
            { status: 422 },
          )
        }
        parsedEntry = rawFallbackEntry(input)
        isFallback = true
      }
      parsed = {
        ...parsedEntry,
        manuallyRequested: true,
        kind: body.kind === 'book' ? 'book' : 'feed',
      }
    } else {
      return NextResponse.json(
        { error: 'Must provide either { input } or { title, author, platform }' },
        { status: 400 },
      )
    }
  } catch (err) {
    console.error('[Add Entry] Invalid request body:', err)
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  // Default empty author to "Unknown" BEFORE the dedup check — the lookup and
  // the insert must see the same author, or the DB RPC's own title+author
  // dedup can hit an item the app-level matcher missed and the route then
  // tries to queue-position a pre-existing (possibly archived) item (#176).
  // (The DB RPC also requires a non-empty author; the free-form parser may
  // produce one, structured input is already validated above.)
  const itemForInsert: SyncItem = {
    ...parsed,
    author: parsed.author.trim() || 'Unknown',
  }

  // --- Dedup -------------------------------------------------------------
  // A match means nothing new is created; the response carries action:
  // 'existing' so the client does NOT show a "created / will appear shortly"
  // success (#176).
  let match
  try {
    match = await findMatchingContent(itemForInsert, supabase)
  } catch (err) {
    console.error('[Add Entry] Matching lookup failed:', err)
    await logError('add-entry', err)
    return NextResponse.json(
      { error: "Couldn't save the entry — please try again.", stage: 'insert' },
      { status: 500 },
    )
  }
  if (match) {
    return NextResponse.json({
      success: true,
      action: 'existing',
      title: parsed.title,
      author: parsed.author,
    })
  }

  // --- Create ------------------------------------------------------------
  let contentItemId: number
  let insertedNewItem: boolean
  try {
    // #381: record the add as the owner's own pick (added_by 'Ben'), the signal the
    // queue curator reads. 'tasklet' only picks the platform fallback, which
    // this path never needs: both input shapes always carry a platform.
    const created = await createContent(itemForInsert, 'tasklet', supabase, { addedBy: 'Ben' })
    contentItemId = created.contentItemId
    insertedNewItem = created.inserted
  } catch (err) {
    // createContent is self-cleaning on a positioning failure (#176), so a
    // failure here means nothing persisted — it is honest (and safe) to ask
    // the user to retry.
    console.error('[Add Entry] Insert failed:', err)
    await logError('add-entry', err)
    return NextResponse.json(
      { error: "Couldn't save the entry — please try again.", stage: 'insert' },
      { status: 500 },
    )
  }

  // The RPC can still dedup onto a pre-existing item (e.g. a cron sync created
  // it between our match check and the insert). Nothing new was created, so
  // report 'existing' — not a false 'created' (#176).
  if (!insertedNewItem) {
    return NextResponse.json({
      success: true,
      action: 'existing',
      title: parsed.title,
      author: parsed.author,
    })
  }

  // #377: what the owner adds himself goes straight to the top of home. Keyed on
  // this add path, not on added_by (a deduped insert keeps the old row's value).
  // Best-effort: the item exists either way, so a failed pin doesn't fail the add.
  if (parsed.kind !== 'book') {
    try {
      await pinContentItem(supabase, contentItemId)
    } catch (err) {
      console.error('[Add Entry] Pin failed:', err)
      await logError('add-entry', err)
    }
  }

  // Generate AI summary in background — feed items only. Books don't need a
  // summary at add time (most are seeded via Goodreads with no synopsis the
  // model can rely on). Raw fallback items (#191) have no readable content, so
  // there is nothing to summarize.
  if (parsed.kind !== 'book' && !isFallback) {
    after(async () => {
      try {
        await generateSummary(contentItemId, { skipExisting: true, auto: true })
      } catch (e) {
        console.error('[Add Entry] Background summary generation failed:', e)
      }
    })
  }

  return NextResponse.json({
    success: true,
    action: 'created',
    title: parsed.title,
    author: parsed.author,
    platform: parsed.platform,
    // #191: signals the Shortcut to show "Saved for cleanup" — enrichment
    // failed and only the raw URL was stored. Created-only by design: the
    // dedup 'existing' returns omit it (nothing new was saved, and the
    // Shortcut branches on `action` anyway).
    ...(isFallback ? { fallback: true } : {}),
  })
}
