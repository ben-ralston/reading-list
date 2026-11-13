import type { SummaryData } from "@/lib/summary-data"

// Inline AI one-liner on queue cards (#304). Legacy text-only summaries
// (summaryData null) intentionally render nothing here: they're paragraphs.
// Clamped to 2 lines for scanning; `expanded` (the card's summary panel is
// open) shows the whole sentence, since the panel's bullets don't repeat it.
export function SummaryOneLiner({
  summaryData,
  expanded = false,
  className = "",
}: {
  summaryData: SummaryData | null | undefined
  expanded?: boolean
  className?: string
}) {
  if (!summaryData) return null
  return (
    <p
      data-testid="summary-one-liner"
      className={`text-sm leading-snug text-muted-foreground ${expanded ? "" : "line-clamp-2"} ${className}`}
    >
      {summaryData.oneLiner}
    </p>
  )
}
