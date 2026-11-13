"use client"

import { useState } from "react"
import { Sparkles, RefreshCw, ExternalLink, Loader2 } from "lucide-react"
import type { SummaryData } from "@/lib/summary-data"

function renderBoldText(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  )
}

interface SummarySectionProps {
  contentItemId: number
  summary: string | null | undefined
  summaryData?: SummaryData | null
  summaryGeneratedAt: string | null | undefined
  itemTitle: string
  itemLink: string | null
  onSummaryGenerated?: (summary: string, generatedAt: string, summaryData: SummaryData | null) => void
}

function SourceChip({ access }: { access: SummaryData["sourceAccess"] }) {
  const full = access === "full_text"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        full
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      }`}
    >
      {full ? "Read full text" : "Descriptions only"}
    </span>
  )
}

// Build prompt and open Claude for follow-up conversation
function openInClaude(title: string, link: string | null) {
  const prompt = link
    ? `Please summarize this content for me:\n\nTitle: ${title}\nLink: ${link}\n\nProvide a concise summary and let me know if you have any questions about what I'm looking for.`
    : `Please help me understand this content:\n\nTitle: ${title}\n\nI don't have a direct link, but can you help me find and summarize information about this?`

  if (typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
    const shortcutUrl = `shortcuts://run-shortcut?name=${encodeURIComponent('Ask Claude With Prompt')}&input=text&text=${encodeURIComponent(prompt)}`
    window.location.href = shortcutUrl
  } else {
    const claudeUrl = `https://claude.ai/new?q=${encodeURIComponent(prompt)}`
    window.open(claudeUrl, "_blank", "noopener,noreferrer")
  }
}

export function SummarySection({
  contentItemId,
  summary,
  summaryData,
  summaryGeneratedAt,
  itemTitle,
  itemLink,
  onSummaryGenerated,
}: SummarySectionProps) {
  const [isGenerating, setIsGenerating] = useState(false)
  const [displaySummary, setDisplaySummary] = useState(summary)
  const [prevSummary, setPrevSummary] = useState(summary)
  const [error, setError] = useState<string | null>(null)

  // Re-sync displaySummary when the prop changes (parent refresh). Setting state
  // during render is React-blessed for "adjust state when a prop changes" and
  // avoids the cascading-render warning from setState-in-effect.
  if (summary !== prevSummary) {
    setPrevSummary(summary)
    setDisplaySummary(summary)
  }
  const [displayData, setDisplayData] = useState(summaryData ?? null)
  const [prevData, setPrevData] = useState(summaryData ?? null)
  if ((summaryData ?? null) !== prevData) {
    setPrevData(summaryData ?? null)
    setDisplayData(summaryData ?? null)
  }

  const handleGenerate = async () => {
    setIsGenerating(true)
    setError(null)

    try {
      const response = await fetch("/api/summary/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentItemId }),
      })

      if (!response.ok) {
        throw new Error("Failed to generate summary")
      }

      const result = await response.json()
      setDisplaySummary(result.summary)
      setDisplayData(result.summaryData ?? null)
      onSummaryGenerated?.(result.summary, result.generatedAt, result.summaryData ?? null)
    } catch (err) {
      setError("Failed to generate summary. Please try again.")
      console.error(err)
    } finally {
      setIsGenerating(false)
    }
  }

  // State: Generating
  if (isGenerating) {
    return (
      <div className="mt-3 rounded-lg border border-border bg-muted/30 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-center gap-2 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Generating summary...</span>
        </div>
      </div>
    )
  }

  // State: No summary yet
  if (!displaySummary) {
    return (
      <div className="mt-3 rounded-lg border border-border bg-muted/30 p-4 text-center" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm text-muted-foreground mb-3">No summary generated yet</p>
        {error && <p className="text-sm text-destructive mb-2">{error}</p>}
        <button
          onClick={handleGenerate}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded-lg transition-colors border border-primary/20"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Generate Summary
        </button>
      </div>
    )
  }

  // State: Summary available
  return (
    <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-4" onClick={(e) => e.stopPropagation()}>
      {displayData ? (
        <>
          <div className="flex items-center gap-1.5 mb-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="text-sm font-medium text-primary">More</span>
          </div>
          {displayData.bullets.length > 0 ? (
            <ul className="list-disc pl-5 space-y-1 text-sm leading-relaxed text-foreground">
              {displayData.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          ) : (
            <p className="text-sm leading-relaxed text-foreground">{displayData.oneLiner}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <SourceChip access={displayData.sourceAccess} />
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5 mb-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="text-sm font-medium text-primary">AI Summary</span>
          </div>
          <p className="text-sm leading-relaxed text-foreground">{renderBoldText(displaySummary)}</p>
        </>
      )}
      {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={handleGenerate}
          className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Regenerate
        </button>
        <span className="text-muted-foreground/40">|</span>
        <button
          onClick={() => openInClaude(itemTitle, itemLink)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Ask follow-up in Claude
          <ExternalLink className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
