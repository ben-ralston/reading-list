import { supabase } from '@/lib/supabase'
import { ALLOWED_BACKFILL_PRESETS } from '@/lib/rss/backfill-presets'

// Re-exported for server-side callers that already import it from here.
// The canonical definition lives in the side-effect-free presets module so
// client components can import it without dragging in @/lib/supabase.
export { ALLOWED_BACKFILL_PRESETS }

const DEFAULT_BACKFILL_KEY = 'default_backfill_days'

/**
 * The global "backfill new feeds by default" window in days, or null when off.
 * Fails safe to null (off) on any read error — an unreadable setting must never
 * cause an unexpected bulk backfill.
 */
export async function getDefaultBackfillDays(): Promise<number | null> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', DEFAULT_BACKFILL_KEY)
    .maybeSingle()

  if (error || !data?.value) return null
  const n = Number(data.value)
  return Number.isInteger(n) && (ALLOWED_BACKFILL_PRESETS as readonly number[]).includes(n)
    ? n
    : null
}

/**
 * Set (or clear) the global default. null deletes the row — "off" is the
 * absence of the setting, never an empty string. Throws on a non-preset value.
 */
export async function setDefaultBackfillDays(days: number | null): Promise<void> {
  if (days === null) {
    const { error } = await supabase
      .from('app_settings')
      .delete()
      .eq('key', DEFAULT_BACKFILL_KEY)
    if (error) throw new Error(error.message)
    return
  }

  if (!(ALLOWED_BACKFILL_PRESETS as readonly number[]).includes(days)) {
    throw new Error(`Invalid backfill default: ${days}`)
  }

  const { error } = await supabase.from('app_settings').upsert({
    key: DEFAULT_BACKFILL_KEY,
    value: String(days),
    updated_at: new Date().toISOString(),
  })
  if (error) throw new Error(error.message)
}

// When the owner last opened /everything (#377): items added after it get a NEW
// badge there. One row shared by every device.
const EVERYTHING_LAST_SEEN_KEY = 'everything_last_seen_at'

/** The previous visit's time (ISO), or null before the first visit or on any read error. */
export async function getEverythingLastSeen(): Promise<string | null> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', EVERYTHING_LAST_SEEN_KEY)
    .maybeSingle()
  if (error || !data?.value) return null
  return Number.isNaN(Date.parse(data.value)) ? null : data.value
}

/**
 * Record a visit. A time ahead of the server clock is clamped to now, and the
 * stored time never moves backwards (an older tab posting late would otherwise
 * bring back NEW badges already seen).
 */
export async function setEverythingLastSeen(seenAt: string, nowMs: number): Promise<void> {
  const at = Date.parse(seenAt)
  if (Number.isNaN(at)) throw new Error(`Invalid time: ${seenAt}`)
  const clamped = Math.min(at, nowMs)
  const current = await getEverythingLastSeen()
  if (current && Date.parse(current) >= clamped) return
  const value = new Date(clamped).toISOString()
  const { error } = await supabase.from('app_settings').upsert({
    key: EVERYTHING_LAST_SEEN_KEY,
    value,
    updated_at: new Date(nowMs).toISOString(),
  })
  if (error) throw new Error(error.message)
}
