"use client"

import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { SyncResult } from "@/lib/types"

interface SpotifySyncButtonProps {
  isSyncing: boolean
  onSync: () => Promise<SyncResult | null>
}

export function SpotifySyncButton({ isSyncing, onSync }: SpotifySyncButtonProps) {
  const handleSync = async () => {
    const result = await onSync()

    if (!result) return // Sync was skipped (already in progress)

    if (!result.success) {
      toast.error("Sync failed", {
        description: result.error || "Unknown error occurred",
      })
      return
    }

    // Build summary message
    const parts: string[] = []
    if (result.created > 0) {
      parts.push(`${result.created} new item${result.created === 1 ? "" : "s"} added`)
    }
    if (result.updated > 0) {
      parts.push(`${result.updated} item${result.updated === 1 ? "" : "s"} updated`)
    }
    if (result.skipped > 0) {
      parts.push(`${result.skipped} skipped`)
    }

    if (parts.length === 0) {
      toast.info("Spotify sync complete", {
        description: "No changes found",
      })
    } else {
      toast.success("Spotify sync complete", {
        description: parts.join(", "),
      })
    }
  }

  return (
    <button
      onClick={handleSync}
      disabled={isSyncing}
      className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
      title="Sync Spotify progress"
    >
      {isSyncing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <SpotifyIcon className="h-4 w-4" />
      )}
    </button>
  )
}

function SpotifyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  )
}
