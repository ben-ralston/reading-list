'use client'

import { useHydrated } from '@/lib/use-hydrated'
import { clockTime, fullDateTime } from '@/lib/format-time'

/**
 * Clock time in the viewer's local zone, for timestamps inside server-rendered
 * pages (#282). The Status page is an RSC, so formatting there runs on Vercel
 * in UTC; this component instead formats after hydration, in the browser. The
 * SSR/hydration pass renders the same instant explicitly labelled "UTC" so it
 * is never an unlabelled wrong-zone time, and a full-date tooltip disambiguates
 * the day.
 */
export function LocalTime({ iso, className }: { iso: string | null; className?: string }) {
  const hydrated = useHydrated()
  if (!iso) return <span className={className}>—</span>
  const opts = hydrated ? {} : { timeZone: 'UTC' }
  return (
    <time dateTime={iso} className={className} title={fullDateTime(iso, opts)}>
      {clockTime(iso, opts)}
    </time>
  )
}
