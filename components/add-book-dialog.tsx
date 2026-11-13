"use client"

// AddBookDialog — agentic "add a book" flow on /books (#186, building on #147).
//
// Two phases in one dialog:
//   1. input  — a single field that takes a book URL OR free text (title /
//      "title author" / ISBN). "Look up" calls /api/books/lookup, which runs an
//      agentic Claude lookup (web_search) for title, author, subtitle, series,
//      ISBN-13, a canonical Goodreads link, and a cover image.
//        • HIGH confidence  → auto-save straight to /api/add-entry (toast, close).
//        • LOW confidence / lookup failure → fall through to the editable form
//          pre-filled with whatever was found (graceful degradation).
//      An "Enter manually" escape hatch skips lookup entirely.
//   2. form   — the classic structured fields (title, author, format, link) plus
//      the agent-found subtitle / series / ISBN-13 and a cover preview, all
//      editable before saving.
//
// Creation always goes through /api/add-entry with kind='book' (the single
// dedup + smart-position + orphan-cleanup path). Agent-added books default their
// primary source platform to 'Goodreads' with the found link (or null).
//
// NOTE: do NOT import from @/lib/book-parser at runtime here — it pulls in the
// Anthropic SDK. Only the BookMetadata *type* is imported (erased at build).

import { useState } from "react"
import { Send, Search } from "lucide-react"
import { toast } from "sonner"
import { fetchWithRetry } from "@/lib/fetch-with-retry"
import type { BookMetadata } from "@/lib/book-parser"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog"

interface AddBookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful add so the parent can refresh its queue. */
  onAdded?: () => void
}

type BookFormat = 'Audible' | 'Kindle' | 'Physical' | 'Library' | 'Goodreads' | 'Web' | 'Other'

const FORMATS: BookFormat[] = ['Audible', 'Kindle', 'Physical', 'Library', 'Goodreads', 'Web', 'Other']

const inputClass =
  "w-full p-3 text-sm border border-input bg-background rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"

// Physical / Library / Other don't have to have a URL.
function formatRequiresLink(format: BookFormat): boolean {
  return !(format === 'Physical' || format === 'Library' || format === 'Other')
}

function isUrlInput(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export function AddBookDialog({ open, onOpenChange, onAdded }: AddBookDialogProps) {
  const [phase, setPhase] = useState<'input' | 'form'>('input')

  // Phase 1 (lookup) state
  const [lookupInput, setLookupInput] = useState("")
  const [isLookingUp, setIsLookingUp] = useState(false)

  // Phase 2 (form) state
  const [title, setTitle] = useState("")
  const [author, setAuthor] = useState("")
  const [format, setFormat] = useState<BookFormat>('Audible')
  const [link, setLink] = useState("")
  const [subtitle, setSubtitle] = useState("")
  const [series, setSeries] = useState("")
  const [isbn13, setIsbn13] = useState("")
  const [coverImageUrl, setCoverImageUrl] = useState("")
  const [publishedOn, setPublishedOn] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  const resetAll = () => {
    setPhase('input')
    setLookupInput("")
    setIsLookingUp(false)
    setTitle("")
    setAuthor("")
    setFormat('Audible')
    setLink("")
    setSubtitle("")
    setSeries("")
    setIsbn13("")
    setCoverImageUrl("")
    setPublishedOn("")
    setIsSubmitting(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) resetAll()
    onOpenChange(next)
  }

  /** Seed the editable form from agent metadata (low-confidence / fallback path). */
  const populateForm = (meta: Partial<BookMetadata>) => {
    setTitle(meta.title ?? "")
    setAuthor(meta.author ?? "")
    // Agent-found books default to Goodreads (where the canonical link lives).
    setFormat('Goodreads')
    setLink(meta.goodreadsUrl ?? "")
    setSubtitle(meta.subtitle ?? "")
    setSeries(meta.series ?? "")
    setIsbn13(meta.isbn13 ?? "")
    setCoverImageUrl(meta.coverImageUrl ?? "")
    setPublishedOn(meta.publishedOn ?? "")
    setPhase('form')
  }

  /**
   * POST a structured book to /api/add-entry. Returns true on a successful save
   * (and closes the dialog), false otherwise (after showing an error toast).
   */
  const submitBook = async (payload: Record<string, unknown>): Promise<boolean> => {
    try {
      // add-entry is non-idempotent — do not retry.
      const response = await fetchWithRetry(
        "/api/add-entry",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: 'book', ...payload }),
        },
        { retries: 0 },
      )

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to add book")
      }

      const data = await response.json()
      toast.success(
        data.action === 'existing'
          ? `Already in your library: ${data.title}`
          : `Added: ${data.title}`,
      )
      onAdded?.()
      handleOpenChange(false)
      return true
    } catch (err) {
      console.error("Error adding book:", err)
      toast.error(err instanceof Error ? err.message : "Failed to add book")
      return false
    }
  }

  const handleLookup = async () => {
    const input = lookupInput.trim()
    if (!input) return

    setIsLookingUp(true)
    try {
      // Lookup is an expensive agentic call — do not retry.
      const response = await fetchWithRetry(
        "/api/books/lookup",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        },
        { retries: 0 },
      )
      if (!response.ok) throw new Error("Lookup failed")

      const data = (await response.json()) as { metadata: BookMetadata; confidence: string }
      const meta = data.metadata

      if (data.confidence === 'high') {
        const saved = await submitBook({
          title: meta.title,
          author: meta.author,
          platform: 'Goodreads',
          link: meta.goodreadsUrl ?? null,
          subtitle: meta.subtitle ?? null,
          series: meta.series ?? null,
          isbn13: meta.isbn13 ?? null,
          imageUrl: meta.coverImageUrl ?? null,
          publishedOn: meta.publishedOn,
        })
        if (saved) return
        // Auto-save failed — drop to the form so nothing the agent found is lost.
        populateForm(meta)
        return
      }

      // Low confidence — let the user review/complete the pre-filled form.
      populateForm(meta)
    } catch (err) {
      console.error("Book lookup failed:", err)
      // Graceful degradation: still give the user the form. Seed free text as
      // the title (a raw URL would be junk, so leave that blank).
      populateForm({ title: isUrlInput(input) ? "" : input })
    } finally {
      setIsLookingUp(false)
    }
  }

  const handleManual = () => {
    setTitle("")
    setAuthor("")
    setFormat('Audible')
    setLink("")
    setSubtitle("")
    setSeries("")
    setIsbn13("")
    setCoverImageUrl("")
    setPublishedOn("")
    setPhase('form')
  }

  const linkRequired = formatRequiresLink(format)

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !author.trim()) return
    if (linkRequired && !link.trim()) {
      toast.error(`${format} requires a link`)
      return
    }

    setIsSubmitting(true)
    await submitBook({
      title: title.trim(),
      author: author.trim(),
      platform: format,
      link: link.trim() || null,
      subtitle: subtitle.trim() || null,
      series: series.trim() || null,
      isbn13: isbn13.trim() || null,
      imageUrl: coverImageUrl || null,
      publishedOn: publishedOn || undefined,
    })
    setIsSubmitting(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a book</DialogTitle>
          <DialogDescription>
            {phase === 'input'
              ? "Paste a book link or type a title — we'll look up the details."
              : "Review the details, then add the book."}
          </DialogDescription>
        </DialogHeader>

        {phase === 'input' ? (
          <div className="space-y-3">
            <input
              type="text"
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleLookup()
                }
              }}
              placeholder="Paste a book URL, or type a title / author / ISBN"
              className={inputClass}
              disabled={isLookingUp}
              autoFocus
            />
            <Button
              type="button"
              onClick={handleLookup}
              disabled={isLookingUp || !lookupInput.trim()}
              className="w-full"
            >
              <Search className="h-4 w-4 mr-2" />
              {isLookingUp ? "Looking up..." : "Look up"}
            </Button>
            <button
              type="button"
              onClick={handleManual}
              disabled={isLookingUp}
              className="w-full text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              Enter manually
            </button>
          </div>
        ) : (
          <form onSubmit={handleFormSubmit} className="space-y-3">
            {coverImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverImageUrl}
                alt=""
                className="h-24 w-auto mx-auto rounded shadow-sm"
              />
            ) : null}
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              className={inputClass}
              disabled={isSubmitting}
              autoFocus
            />
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Author"
              className={inputClass}
              disabled={isSubmitting}
            />
            <input
              type="text"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="Subtitle (optional)"
              className={inputClass}
              disabled={isSubmitting}
            />
            <input
              type="text"
              value={series}
              onChange={(e) => setSeries(e.target.value)}
              placeholder="Series (optional)"
              className={inputClass}
              disabled={isSubmitting}
            />
            <input
              type="text"
              value={isbn13}
              onChange={(e) => setIsbn13(e.target.value)}
              placeholder="ISBN-13 (optional)"
              className={inputClass}
              disabled={isSubmitting}
            />
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as BookFormat)}
              className={inputClass}
              disabled={isSubmitting}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder={linkRequired ? 'Link (required)' : 'Link (optional)'}
              className={inputClass}
              disabled={isSubmitting}
            />
            <Button
              type="submit"
              disabled={isSubmitting || !title.trim() || !author.trim() || (linkRequired && !link.trim())}
              className="w-full"
            >
              <Send className="h-4 w-4 mr-2" />
              {isSubmitting ? "Adding..." : "Add book"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
