import { NextResponse } from 'next/server'
import RssParser from 'rss-parser'
import { detectFeedType, type FeedType } from '@/lib/rss/detect'
import { fetchFeed } from '@/lib/rss/fetch-feed'
import { listFeeds, insertFeed } from '@/lib/rss/feeds-repo'
import { UnsafeUrlError } from '@/lib/safe-fetch'

export const dynamic = 'force-dynamic'

const PLATFORM_BY_TYPE: Record<FeedType, string> = {
  substack: 'Substack',
  lesswrong: 'LessWrong',
  generic: 'RSS',
}

export async function GET(request: Request) {
  const includeDisabled =
    new URL(request.url).searchParams.get('include') === 'disabled'
  try {
    const feeds = await listFeeds({ includeDisabled })
    return NextResponse.json(feeds)
  } catch (e) {
    console.error('[Feeds API] GET failed:', e)
    return NextResponse.json({ error: 'Failed to load feeds' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  let body: {
    url?: unknown; label?: unknown; authorName?: unknown
    platform?: unknown; backfillDays?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
  if (!rawUrl) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }

  let url: string
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
    url = parsed.toString()
  } catch {
    return NextResponse.json({ error: 'Malformed URL' }, { status: 400 })
  }

  let existing
  try {
    existing = await listFeeds({ includeDisabled: true })
  } catch (e) {
    console.error('[Feeds API] dup-check listFeeds failed:', e)
    return NextResponse.json({ error: 'Failed to check existing feeds' }, { status: 500 })
  }
  if (existing.some((f) => f.url === url)) {
    return NextResponse.json({ error: 'Feed already exists' }, { status: 409 })
  }

  // Optional opt-in first-poll backfill window (#164). Absent/null = off.
  let backfillDays: number | null = null
  if (body.backfillDays != null) {
    const n = body.backfillDays
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > 3650) {
      return NextResponse.json(
        { error: 'backfillDays must be an integer between 1 and 3650' },
        { status: 400 },
      )
    }
    backfillDays = n
  }

  let channelTitle = ''
  try {
    // SSRF-guarded fetch (#206): rss-parser's parseURL follows redirects and
    // has no private-IP check, so the fetch goes through fetchFeed/safeFetch.
    const feed = await fetchFeed(url, new RssParser())
    if (!feed.items || feed.items.length === 0) {
      return NextResponse.json(
        { error: 'URL did not return any RSS items' },
        { status: 422 }
      )
    }
    channelTitle = (feed.title ?? '').trim()
  } catch (e) {
    if (e instanceof UnsafeUrlError) {
      return NextResponse.json(
        { error: 'URL resolves to a blocked or private address' },
        { status: 422 }
      )
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: `Could not fetch or parse feed: ${msg}` },
      { status: 422 }
    )
  }

  const feedType = detectFeedType(url)
  const label =
    (typeof body.label === 'string' && body.label.trim()) ||
    channelTitle ||
    url
  const authorName =
    (typeof body.authorName === 'string' && body.authorName.trim()) ||
    channelTitle ||
    null
  const platform =
    (typeof body.platform === 'string' && body.platform.trim()) ||
    PLATFORM_BY_TYPE[feedType]

  try {
    const created = await insertFeed({ url, label, authorName, platform, feedType, backfillDays })
    return NextResponse.json(created, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('duplicate') || msg.includes('unique')) {
      return NextResponse.json({ error: 'Feed already exists' }, { status: 409 })
    }
    console.error('[Feeds API] insert failed:', e)
    return NextResponse.json({ error: 'Failed to create feed' }, { status: 500 })
  }
}
