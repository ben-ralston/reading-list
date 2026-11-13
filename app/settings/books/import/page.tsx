"use client"

// /settings/books/import — Goodreads CSV uploader (#147).
//
// Lives alongside /settings/feeds and /settings/status. On upload, POSTs
// the file to /api/import/goodreads, then renders the returned counts and
// skip reasons. Re-running on the same CSV is idempotent — created falls
// to 0 and every row counts as "updated".

import Link from "next/link"
import { useState } from "react"
import { Loader2, Upload } from "lucide-react"
import { fetchWithRetry } from "@/lib/fetch-with-retry"
import { Button } from "@/components/ui/button"

interface ImportResult {
  success: true
  created: number
  updated: number
  skipped: number
  syncLogId: number
  skipReasons: Array<{ row: number; reason: string }>
}

export default function GoodreadsImportPage() {
  const [file, setFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return
    setError(null)
    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      // The import endpoint is non-idempotent at the HTTP layer (creates
      // sync_logs row, writes content) — do not retry.
      const response = await fetchWithRetry(
        "/api/import/goodreads",
        { method: "POST", body: formData },
        { retries: 0 },
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${response.status}`)
      }
      const data = (await response.json()) as ImportResult
      setResult(data)
    } catch (err) {
      console.error("[Goodreads Import UI] Upload failed:", err)
      setError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setIsUploading(false)
    }
  }

  // app/settings/layout.tsx renders the back-to-home link, "Settings" heading,
  // and SettingsNav strip; this page only owns its sub-heading + content.
  return (
    <>
      <h2 className="mt-6 text-xl font-semibold">Import from Goodreads</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Seed your books list from a Goodreads CSV export.
      </p>

      <ol className="mt-4 text-sm text-muted-foreground space-y-1 list-decimal list-inside">
        <li>
          On Goodreads: <strong>My Books → Import/Export → Export Library</strong>.
        </li>
        <li>Wait for the email or refresh and download the CSV.</li>
        <li>Upload it below. Re-running on the same CSV is safe — duplicates are skipped.</li>
      </ol>

      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={isUploading}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-accent"
        />
        <Button type="submit" disabled={!file || isUploading} className="w-full sm:w-auto">
          {isUploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Importing…
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              Import
            </>
          )}
        </Button>
      </form>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-md border bg-card p-4 text-sm space-y-2">
          <p>
            <strong>{result.created}</strong> created · <strong>{result.updated}</strong> updated ·{" "}
            <strong>{result.skipped}</strong> skipped
          </p>
          <p className="text-muted-foreground">
            See <Link href="/settings/status" className="underline">Sync status</Link> for the run record.
          </p>
          {result.skipReasons.length > 0 && (
            <details className="text-muted-foreground">
              <summary className="cursor-pointer">Skipped rows ({result.skipReasons.length})</summary>
              <ul className="mt-2 space-y-1 pl-4 list-disc">
                {result.skipReasons.slice(0, 50).map((s, i) => (
                  <li key={i}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
                {result.skipReasons.length > 50 && <li>… and {result.skipReasons.length - 50} more</li>}
              </ul>
            </details>
          )}
          <p>
            <Link href="/books" className="underline">View your books →</Link>
          </p>
        </div>
      )}
    </>
  )
}
