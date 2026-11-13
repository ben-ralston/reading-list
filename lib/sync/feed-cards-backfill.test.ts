import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enrichOneFeedItem, type FeedItemRow } from './feed-cards-backfill'
import * as enrich from '@/lib/rss/enrich'

// Minimal supabase fake recording content_items.update({...}).is(col,val).eq(col, id)
function makeSupabase() {
  const updates: { payload: Record<string, unknown>; id: unknown }[] = []
  const supabase = {
    from(table: string) {
      expect(table).toBe('content_items')
      return {
        update(payload: Record<string, unknown>) {
          const chain = {
            is(_col: string, _val: unknown) {
              return chain
            },
            eq(_col: string, id: unknown) {
              updates.push({ payload, id })
              return Promise.resolve({ error: null })
            },
          }
          return chain
        },
      }
    },
  } as unknown as SupabaseClient
  return { supabase, updates }
}

const ROW: FeedItemRow = { id: 7, title: 'A Post', link: 'https://blog.example.com/post' }

describe('enrichOneFeedItem', () => {
  beforeEach(() => {
    vi.spyOn(enrich, 'enrichFromUrl')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns no-link and never fetches when the row has no link', async () => {
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneFeedItem({ id: 1, title: 'x', link: null }, supabase, { dryRun: false })
    expect(result.action).toBe('no-link')
    expect(enrich.enrichFromUrl).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('writes image_url only (not word_count) when an image is found', async () => {
    // Backfill is image-focused; writing word_count would leave image_url NULL on
    // image-less rows, breaking the "image_url IS NULL" idempotency filter.
    vi.mocked(enrich.enrichFromUrl).mockResolvedValue({ imageUrl: 'https://cdn.example.com/og.jpg', wordCount: 900 })
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneFeedItem(ROW, supabase, { dryRun: false })
    expect(result.action).toBe('enriched')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({ payload: { image_url: 'https://cdn.example.com/og.jpg' }, id: 7 })
  })

  it('does not write when only a word count (no image) is found — keeps re-runs idempotent', async () => {
    vi.mocked(enrich.enrichFromUrl).mockResolvedValue({ imageUrl: null, wordCount: 900 })
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneFeedItem(ROW, supabase, { dryRun: false })
    expect(result.action).toBe('no-image-found')
    expect(updates).toHaveLength(0)
  })

  it('does not write in dry-run mode', async () => {
    vi.mocked(enrich.enrichFromUrl).mockResolvedValue({ imageUrl: 'https://cdn.example.com/og.jpg', wordCount: null })
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneFeedItem(ROW, supabase, { dryRun: true })
    expect(result.action).toBe('enriched')
    expect(updates).toHaveLength(0)
  })

  it('returns no-image-found and writes nothing when enrichment is empty', async () => {
    vi.mocked(enrich.enrichFromUrl).mockResolvedValue({ imageUrl: null, wordCount: null })
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneFeedItem(ROW, supabase, { dryRun: false })
    expect(result.action).toBe('no-image-found')
    expect(updates).toHaveLength(0)
  })
})
