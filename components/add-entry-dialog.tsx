"use client"

import { useState } from "react"
import { Send } from "lucide-react"
import { toast } from "sonner"
import { fetchWithRetry } from "@/lib/fetch-with-retry"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog"

interface AddEntryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // #377: called after a successful add so the page can reload; a new feed
  // entry is pinned server-side and should show at the top of home at once.
  onAdded?: () => void
}

export function AddEntryDialog({ open, onOpenChange, onAdded }: AddEntryDialogProps) {
  const [input, setInput] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!input.trim()) return

    setIsSubmitting(true)

    try {
      // add-entry is non-idempotent (creates new item) — do not retry
      const response = await fetchWithRetry("/api/add-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: input.trim() }),
      }, { retries: 0 })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to add entry")
      }

      // Branch on what the server actually did. A dedup match (action:
      // 'existing') created nothing, so it must NOT show the "it will appear
      // shortly" success — that false-success is the core #176 bug.
      const data = await response.json().catch(() => ({}))
      if (data.action === "existing") {
        toast.info("Already in your list.")
      } else {
        toast.success("Entry submitted! It will appear shortly.")
      }
      setInput("")
      onOpenChange(false)
      onAdded?.()
    } catch (err) {
      console.error("Error adding entry:", err)
      toast.error(err instanceof Error ? err.message : "Failed to add entry")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Entry</DialogTitle>
          <DialogDescription>
            Paste a link or type &quot;title + platform&quot;
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://... or 'Article Name + LessWrong'"
            className="w-full p-3 text-sm border border-input bg-background rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            disabled={isSubmitting}
            autoFocus
          />
          <Button
            type="submit"
            disabled={isSubmitting || !input.trim()}
            className="w-full"
          >
            <Send className="h-4 w-4 mr-2" />
            {isSubmitting ? "Submitting..." : "Add"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
