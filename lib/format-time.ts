/** Relative "Xm/h/d ago" string; "—" when null. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export interface FormatTimeOptions {
  /** IANA zone to render in. Defaults to the runtime's zone — on the server
   *  that is UTC, so server-rendered output must pass 'UTC' explicitly (see
   *  components/local-time.tsx) rather than rely on the default. */
  timeZone?: string
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
const DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }

// Some ICU builds separate the time from AM/PM with U+202F (narrow no-break
// space) while others use a plain space. These strings are rendered both on
// the server and in the browser, so fold it to keep hydration byte-identical.
const foldNnbsp = (s: string) => s.replace(/\u202f/g, ' ')

/** Short clock time with zone abbreviation (e.g. "2:34 PM EDT"); "—" when null.
 *  The abbreviation is what makes a UTC vs local rendering distinguishable (#282). */
export function clockTime(iso: string | null, opts: FormatTimeOptions = {}): string {
  if (!iso) return '—'
  return foldNnbsp(new Date(iso).toLocaleTimeString('en-US', { ...CLOCK, timeZone: opts.timeZone }))
}

/** Full date + time + zone (e.g. "Aug 17, 2026, 2:34 PM EDT"); "—" when null. */
export function fullDateTime(iso: string | null, opts: FormatTimeOptions = {}): string {
  if (!iso) return '—'
  return foldNnbsp(new Date(iso).toLocaleString('en-US', { ...DATE, ...CLOCK, timeZone: opts.timeZone }))
}
