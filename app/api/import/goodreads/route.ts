// POST /api/import/goodreads — Goodreads CSV → SyncItems → matching/upsert (#147)
//
// Accepts a multipart/form-data upload with a `file` field containing a
// Goodreads "Export Library" CSV. Parses it with lib/goodreads/csv-parser.ts,
// then for each row calls insert_or_update_content directly (intentionally
// bypassing createContent's insertAtSmartPosition — most imported books
// are "to-read" and shouldn't take a queue slot; "currently-reading" / "read"
// have their queue_position cleared by the follow-up status update). Logs
// one row to sync_logs with source='goodreads'.
//
// Idempotent: re-running on the same CSV yields created=0 because every row
// matches via title+author (the existing dedup path).

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { parseGoodreadsCsv } from '@/lib/goodreads/csv-parser'
import { findMatchingContent, type SyncItem } from '@/lib/sync/matching'

interface ImportResult {
  success: true
  created: number
  updated: number
  skipped: number
  syncLogId: number
  /** Per-row reasons for skips — surfaced in the UI for debugging. */
  skipReasons: Array<{ row: number; reason: string }>
}

const PLATFORM_PRIORITY_ANY: 'Goodreads' = 'Goodreads'

async function upsertViaRpc(item: SyncItem): Promise<number> {
  const { data, error } = await supabase.rpc('insert_or_update_content', {
    p_title: item.title.trim(),
    p_author: item.author.trim(),
    p_platform: PLATFORM_PRIORITY_ANY,
    p_link: item.link ?? null,
    p_published_on: item.publishedOn || null,
    p_message_id: null,
    p_is_primary: false, // Don't displace an existing primary (e.g. Audible) for matched items.
    p_external_id: item.externalId || null,
    p_added_by: 'goodreads',
    p_kind: 'book',
  })
  if (error) {
    throw error
  }
  // insert_or_update_content stays a scalar BIGINT wrapper over upsert_content_item
  // (#176) — the importer only needs the id, and the scalar contract is stable
  // across deploy ordering.
  return data as number
}

async function applyStatusOnNewBook(
  contentItemId: number,
  item: SyncItem,
): Promise<void> {
  if (!item.status && !item.statusChangedAt) return

  const updates: Record<string, unknown> = {}
  if (item.status) {
    updates.status = item.status
    updates.status_changed_at = item.statusChangedAt ?? new Date().toISOString()
    // Constraint: Completed/Skip items must have queue_position=NULL and
    // position_confirmed=FALSE. Clearing here keeps the row in a valid
    // state even though Goodreads import doesn't set queue_position itself.
    if (item.status === 'Completed') {
      updates.queue_position = null
      updates.position_confirmed = false
    }
  } else if (item.statusChangedAt) {
    updates.status_changed_at = item.statusChangedAt
  }

  const { error } = await supabase
    .from('content_items')
    .update(updates)
    .eq('id', contentItemId)
  if (error) {
    throw error
  }
}

export async function POST(request: Request): Promise<Response> {
  let syncLogId = 0
  try {
    const formData = await request.formData().catch(() => null)
    if (!formData) {
      return NextResponse.json({ error: 'Multipart upload required' }, { status: 400 })
    }
    const file = formData.get('file')
    if (!file || typeof file === 'string' || !('arrayBuffer' in file)) {
      return NextResponse.json({ error: 'Missing file field' }, { status: 400 })
    }
    const buffer = await file.arrayBuffer()
    const text = new TextDecoder('utf-8').decode(buffer)

    const { items, skipped: parseSkipped } = parseGoodreadsCsv(text)

    // Open a sync_logs row. The status page will pick this up automatically.
    const { data: logData, error: logError } = await supabase
      .from('sync_logs')
      .insert({
        source: 'goodreads',
        status: 'running',
        items_processed: 0,
        items_created: 0,
        items_updated: 0,
        items_skipped: parseSkipped.length,
      })
      .select('id')
      .single()
    if (logError) {
      // Non-critical — continue without logging.
      console.error('[Goodreads Import] Failed to create sync log:', logError)
    } else {
      syncLogId = logData.id as number
    }

    let created = 0
    let updated = 0
    let processed = 0
    let skipped = parseSkipped.length
    const skipReasons: Array<{ row: number; reason: string }> = [...parseSkipped]

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      try {
        const match = await findMatchingContent(item, supabase)
        if (match) {
          // Existing item — attach a Goodreads source (no-op if already there).
          // We intentionally do NOT update status/progress for existing items:
          // a one-shot Goodreads import shouldn't be authoritative over the
          // user's curated state in this app.
          await upsertViaRpc(item)
          updated++
        } else {
          const contentItemId = await upsertViaRpc(item)
          await applyStatusOnNewBook(contentItemId, item)
          created++
        }
        processed++
      } catch (rowErr) {
        console.error('[Goodreads Import] Error on row:', item.title, rowErr)
        skipped++
        skipReasons.push({
          row: i + 1,
          reason: rowErr instanceof Error ? rowErr.message : 'unknown error',
        })
      }
    }

    if (syncLogId) {
      const { error: updateError } = await supabase
        .from('sync_logs')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
          items_processed: processed,
          items_created: created,
          items_updated: updated,
          items_skipped: skipped,
        })
        .eq('id', syncLogId)
      if (updateError) {
        console.error('[Goodreads Import] Failed to update sync log:', updateError)
      }
    }

    const result: ImportResult = {
      success: true,
      created,
      updated,
      skipped,
      syncLogId,
      skipReasons,
    }
    return NextResponse.json(result)
  } catch (error) {
    console.error('[Goodreads Import] Unhandled error:', error)
    if (syncLogId) {
      try {
        await supabase
          .from('sync_logs')
          .update({
            status: 'error',
            completed_at: new Date().toISOString(),
            error_message: error instanceof Error ? error.message : 'Unknown error',
          })
          .eq('id', syncLogId)
      } catch (e) {
        console.error('[Goodreads Import] Failed to update error log:', e)
      }
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
