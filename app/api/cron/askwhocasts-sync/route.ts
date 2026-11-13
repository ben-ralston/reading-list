/**
 * Askwho Casts sync — two phases (#226, #237).
 *
 * Private phase: polls the owner's private podcast feed (ASKWHOCASTS_FEED_URL — a
 * bearer-secret URL: never log it, never store it in sync_logs) and attaches
 * finished episodes to their queue items as 'Askwho Casts' content_sources
 * rows. Skipped when the env var is unset.
 *
 * Public phase (#237): syncs the public "AI Article Readings" Spotify show
 * and attaches matching episodes as 'Spotify' content_sources rows. Nothing
 * secret is involved. Always runs.
 *
 * Each phase gets its own sync_logs row ('askwhocasts' / 'askwhocasts_public')
 * and its own error handling, so one failing never blocks the other.
 *
 * Schedule: every 15 minutes at :05/:20/:35/:50 via the Cloudflare Worker.
 */

import { NextResponse } from 'next/server'
import RssParser from 'rss-parser'
import { fetchFeed } from '@/lib/rss/fetch-feed'
import { supabase } from '@/lib/supabase'
import { bearerTokenMatches } from '@/lib/bearer-auth'
import { serializeError } from '@/lib/sync/serialize-error'
import { redactFeedSecret } from '@/lib/sync/redact'
import { parseAwcEpisodes, syncEpisode, type AwcFeedItem } from '@/lib/sync/askwhocasts'
import { getAccessToken } from '@/lib/spotify/auth'
import { isSpotifyServerError, SpotifyApiError } from '@/lib/spotify/client'
import { syncPublicEpisodes } from '@/lib/sync/askwhocasts-public'
import { logError, logWarn } from '@/lib/logger'

const AWC_SOURCE = 'askwhocasts'
const AWC_PUBLIC_SOURCE = 'askwhocasts_public'
// The show has hundreds of permanently-unmatched episodes; keep sync_logs
// metadata bounded (first N titles + the true total).
const UNMATCHED_METADATA_CAP = 50

interface PhaseResult {
  ok: boolean
  summary: Record<string, unknown>
}

export async function GET(request: Request) {
  // Auth: bearer token (cron worker) or session cookie — same as rss-sync.
  const authHeader = request.headers.get('authorization')
  const apiSecret = process.env.SYNC_API_SECRET
  let authenticated = bearerTokenMatches(authHeader, apiSecret)
  if (!authenticated) {
    try {
      const { getSession } = await import('@/lib/auth')
      const session = await getSession()
      if (session.isAuthenticated) authenticated = true
    } catch {
      // Session parsing can fail for external callers with no cookies
    }
  }
  if (!authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const feedUrl = process.env.ASKWHOCASTS_FEED_URL
  let privateResult: PhaseResult
  if (feedUrl) {
    privateResult = await runPrivateSync(feedUrl)
  } else {
    // Loud skip: losing the env var must not silently disable the private
    // sync — the log line is the only runtime signal besides this summary.
    console.warn('[AWC Sync] ASKWHOCASTS_FEED_URL not configured — private phase skipped')
    privateResult = {
      ok: true,
      summary: { status: 'skipped', reason: 'ASKWHOCASTS_FEED_URL not configured' },
    }
  }
  const publicResult = await runPublicSync()

  const success = privateResult.ok && publicResult.ok
  return NextResponse.json(
    {
      success,
      private: privateResult.summary,
      public: publicResult.summary,
    },
    { status: success ? 200 : 500 }
  )
}

async function runPrivateSync(feedUrl: string): Promise<PhaseResult> {
  let syncLogId: number | null = null

  try {
    const { data: logData, error: insertLogError } = await supabase
      .from('sync_logs')
      .insert({
        source: AWC_SOURCE,
        status: 'running',
        items_processed: 0,
        items_created: 0,
        items_updated: 0,
        items_skipped: 0,
      })
      .select('id')
      .single()
    if (insertLogError) {
      console.error('[AWC Sync] Failed to create sync log:', insertLogError)
    } else {
      syncLogId = logData.id
    }

    const parser = new RssParser()
    const parsed = await fetchFeed(feedUrl, parser)
    const episodes = parseAwcEpisodes(parsed.items as unknown as AwcFeedItem[])

    let attached = 0
    let healed = 0
    let skipped = 0
    let itemErrors = 0
    const unmatched: { title: string; sourceUrl: string | null }[] = []

    for (const episode of episodes) {
      try {
        const result = await syncEpisode(episode, supabase)
        if (result === 'attached') attached++
        else if (result === 'healed') healed++
        else if (result === 'unchanged') skipped++
        else unmatched.push({ title: episode.title, sourceUrl: episode.sourceUrl })
      } catch (episodeError) {
        // Errors here (e.g. a DB failure) can echo episode.enclosureUrl,
        // which embeds the feed secret — redact before logging.
        const redactedEpisodeError = redactFeedSecret(serializeError(episodeError).message, feedUrl)
        console.error('[AWC Sync] Error processing episode:', episode.title, redactedEpisodeError)
        itemErrors++
      }
    }

    const processed = episodes.length
    const syncStatus: 'success' | 'partial' = itemErrors > 0 ? 'partial' : 'success'
    const metadata =
      unmatched.length > 0 || itemErrors > 0
        ? {
            ...(unmatched.length > 0 && { unmatched }),
            ...(itemErrors > 0 && { itemErrors }),
          }
        : null

    let syncLogError: string | null = null
    if (syncLogId) {
      const { error: updateError } = await supabase
        .from('sync_logs')
        .update({
          status: syncStatus,
          completed_at: new Date().toISOString(),
          items_processed: processed,
          items_created: attached,
          items_updated: healed,
          items_skipped: skipped + unmatched.length,
          metadata,
        })
        .eq('id', syncLogId)
      if (updateError) {
        syncLogError = updateError.message ?? 'sync_logs update failed'
        console.error('[AWC Sync] Failed to update sync log:', updateError)
        await logError('askwhocasts-sync', updateError, {
          blindSpot: 'sync_logs-write',
          syncLogId,
        })
      }
    } else {
      syncLogError = 'sync_logs insert failed; no row to update'
      await logError('askwhocasts-sync', insertLogError ?? 'sync_logs insert failed; no row to update', {
        blindSpot: 'sync_logs-write',
      })
    }

    return {
      ok: syncLogError === null,
      summary: {
        status: syncStatus,
        processed,
        attached,
        healed,
        skipped,
        unmatched: unmatched.length,
        errors: itemErrors,
        syncLogId: syncLogId || 0,
        ...(syncLogError !== null && { syncLogError }),
      },
    }
  } catch (error) {
    // Some error messages (e.g. safe-fetch's "Too many redirects fetching
    // <url>") embed the fetched URL. ASKWHOCASTS_FEED_URL is a bearer
    // secret — it must never reach console.error or sync_logs, so redact
    // every occurrence before logging/storing anything below.
    const redact = (text: string) => redactFeedSecret(text, feedUrl)

    const serialized = serializeError(error)
    const redactedMessage = redact(serialized.message)
    const redactedDetails = serialized.details
      ? {
          ...(serialized.details.code !== undefined && { code: redact(serialized.details.code) }),
          ...(serialized.details.hint !== undefined && { hint: redact(serialized.details.hint) }),
          ...(serialized.details.details !== undefined && {
            details: redact(serialized.details.details),
          }),
        }
      : null

    console.error('[AWC Sync] Unhandled error:', redactedMessage)
    await logError('askwhocasts-sync', redactedMessage, {
      ...(redactedDetails && { error: redactedDetails }),
      ...(syncLogId && { syncLogId }),
    })
    if (syncLogId) {
      try {
        await supabase
          .from('sync_logs')
          .update({
            status: 'error',
            completed_at: new Date().toISOString(),
            error_message: redactedMessage,
            ...(redactedDetails && { metadata: { error: redactedDetails } }),
          })
          .eq('id', syncLogId)
      } catch (e) {
        console.error('[AWC Sync] Failed to update error log:', e)
      }
    }
    return { ok: false, summary: { status: 'error', error: 'Internal server error' } }
  }
}

async function runPublicSync(): Promise<PhaseResult> {
  let syncLogId: number | null = null

  try {
    const { data: logData, error: insertLogError } = await supabase
      .from('sync_logs')
      .insert({
        source: AWC_PUBLIC_SOURCE,
        status: 'running',
        items_processed: 0,
        items_created: 0,
        items_updated: 0,
        items_skipped: 0,
      })
      .select('id')
      .single()
    if (insertLogError) {
      console.error('[AWC Public Sync] Failed to create sync log:', insertLogError)
    } else {
      syncLogId = logData.id
    }

    const accessToken = await getAccessToken()
    const result = await syncPublicEpisodes(accessToken, supabase)

    const syncStatus: 'success' | 'partial' = result.itemErrors > 0 ? 'partial' : 'success'
    const metadata =
      result.unmatched.length > 0 || result.itemErrors > 0
        ? {
            ...(result.unmatched.length > 0 && {
              unmatched: result.unmatched.slice(0, UNMATCHED_METADATA_CAP),
              unmatchedTotal: result.unmatched.length,
            }),
            ...(result.itemErrors > 0 && { itemErrors: result.itemErrors }),
          }
        : null

    let syncLogError: string | null = null
    if (syncLogId) {
      const { error: updateError } = await supabase
        .from('sync_logs')
        .update({
          status: syncStatus,
          completed_at: new Date().toISOString(),
          items_processed: result.processed,
          items_created: result.attached,
          items_updated: 0,
          items_skipped: result.skipped + result.unmatched.length,
          metadata,
        })
        .eq('id', syncLogId)
      if (updateError) {
        syncLogError = updateError.message ?? 'sync_logs update failed'
        console.error('[AWC Public Sync] Failed to update sync log:', updateError)
        await logError('askwhocasts-public-sync', updateError, {
          blindSpot: 'sync_logs-write',
          syncLogId,
        })
      }
    } else {
      syncLogError = 'sync_logs insert failed; no row to update'
      await logError(
        'askwhocasts-public-sync',
        insertLogError ?? 'sync_logs insert failed; no row to update',
        { blindSpot: 'sync_logs-write' },
      )
    }

    return {
      ok: syncLogError === null,
      summary: {
        status: syncStatus,
        processed: result.processed,
        attached: result.attached,
        skipped: result.skipped,
        unmatched: result.unmatched.length,
        errors: result.itemErrors,
        syncLogId: syncLogId || 0,
        ...(syncLogError !== null && { syncLogError }),
      },
    }
  } catch (error) {
    // No secrets involved in the public show — plain serialization is fine.
    const serialized = serializeError(error)
    console.error('[AWC Public Sync] Unhandled error:', serialized.message)
    // A Spotify 5xx has already been retried by the client: warn, not error,
    // so the alerting job does not file an issue per outage (#342). The phase is
    // still marked errored in sync_logs below.
    const report = isSpotifyServerError(error) ? logWarn : logError
    await report('askwhocasts-public-sync', serialized.message, {
      ...(serialized.details && { error: serialized.details }),
      ...(syncLogId && { syncLogId }),
      ...(error instanceof SpotifyApiError && { spotifyStatus: error.statusCode }),
    })
    if (syncLogId) {
      try {
        await supabase
          .from('sync_logs')
          .update({
            status: 'error',
            completed_at: new Date().toISOString(),
            error_message: serialized.message,
            ...(serialized.details && { metadata: { error: serialized.details } }),
          })
          .eq('id', syncLogId)
      } catch (e) {
        console.error('[AWC Public Sync] Failed to update error log:', e)
      }
    }
    return { ok: false, summary: { status: 'error', error: serialized.message } }
  }
}
