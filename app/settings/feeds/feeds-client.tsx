'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, MoreVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import type { RssFeed } from '@/lib/rss/feeds-repo'
import { ALLOWED_BACKFILL_PRESETS } from '@/lib/rss/backfill-presets'
import { relativeTime } from '@/lib/format-time'

const BACKFILL_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  ...ALLOWED_BACKFILL_PRESETS.map((d) => ({ value: d, label: `${d} days` })),
]

function statusDot(f: RssFeed): { color: string; title: string } {
  if (!f.active) return { color: 'bg-gray-400', title: 'Disabled' }
  if (f.consecutiveErrors >= 3)
    return { color: 'bg-red-500', title: `Failing: ${f.lastError ?? 'unknown error'}` }
  if (f.lastError && !f.lastSuccessAt)
    return { color: 'bg-red-500', title: `Never succeeded: ${f.lastError}` }
  if (f.lastError)
    return { color: 'bg-yellow-500', title: `Recent error: ${f.lastError}` }
  if (f.lastSuccessAt) return { color: 'bg-green-500', title: 'Healthy' }
  return { color: 'bg-gray-300', title: 'Not yet synced' }
}

export function FeedsClient({
  initialFeeds,
  initialDefaultBackfillDays,
}: {
  initialFeeds: RssFeed[]
  initialDefaultBackfillDays: number | null
}) {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [showDisabled, setShowDisabled] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [backfillDays, setBackfillDays] = useState<number | null>(initialDefaultBackfillDays)
  const [defaultBackfill, setDefaultBackfill] = useState<number | null>(initialDefaultBackfillDays)
  const [savingDefault, setSavingDefault] = useState(false)

  const feeds = showDisabled ? initialFeeds : initialFeeds.filter((f) => f.active)

  async function addFeed(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return
    setAdding(true)
    try {
      const res = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), backfillDays }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        label?: string
      }
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to add feed')
        return
      }
      toast.success(`Added "${data.label}"`)
      setUrl('')
      router.refresh()
    } catch {
      toast.error('Network error adding feed')
    } finally {
      setAdding(false)
    }
  }

  async function patchFeed(id: number, patch: Record<string, unknown>, okMsg: string) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/feeds/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        toast.error(data.error ?? 'Update failed')
        return
      }
      toast.success(okMsg)
      router.refresh()
    } catch {
      toast.error('Network error')
    } finally {
      setBusyId(null)
    }
  }

  async function saveDefaultBackfill(next: number | null) {
    setSavingDefault(true)
    const prev = defaultBackfill
    setDefaultBackfill(next)
    try {
      const res = await fetch('/api/settings/feed-defaults', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultBackfillDays: next }),
      })
      if (!res.ok) {
        setDefaultBackfill(prev)
        toast.error('Failed to save default')
        return
      }
      // Keep the add-form selector in sync with the new default within the session.
      setBackfillDays(next)
      toast.success(
        next == null ? 'New feeds will not backfill' : `New feeds will backfill ${next} days`,
      )
    } catch {
      setDefaultBackfill(prev)
      toast.error('Network error saving default')
    } finally {
      setSavingDefault(false)
    }
  }

  function editLabel(f: RssFeed) {
    const next = window.prompt('Feed label', f.label)
    if (next == null || next.trim() === '' || next.trim() === f.label) return
    void patchFeed(f.id, { label: next.trim() }, 'Label updated')
  }

  return (
    <div className="mt-6 space-y-6">
      <form onSubmit={addFeed} className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.substack.com/feed"
          disabled={adding}
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <select
          value={backfillDays ?? ''}
          onChange={(e) => setBackfillDays(e.target.value === '' ? null : Number(e.target.value))}
          disabled={adding}
          aria-label="First-poll backfill window"
          className="rounded-md border border-input bg-background px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {BACKFILL_OPTIONS.map((o) => (
            <option key={o.label} value={o.value ?? ''}>
              {o.value == null ? 'No backfill' : `Backfill ${o.label}`}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={adding || !url.trim()}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add feed'}
        </Button>
      </form>

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={showDisabled}
          onChange={(e) => setShowDisabled(e.target.checked)}
        />
        Show disabled feeds
      </label>

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        Backfill new feeds by default
        <select
          value={defaultBackfill ?? ''}
          onChange={(e) =>
            void saveDefaultBackfill(e.target.value === '' ? null : Number(e.target.value))
          }
          disabled={savingDefault}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {BACKFILL_OPTIONS.map((o) => (
            <option key={o.label} value={o.value ?? ''}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <ul className="divide-y divide-border rounded-md border border-border">
        {feeds.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">
            {!showDisabled && initialFeeds.length > 0
              ? 'No active feeds — enable “Show disabled feeds” to see hidden ones.'
              : 'No feeds.'}
          </li>
        )}
        {feeds.map((f) => {
          const dot = statusDot(f)
          return (
            <li key={f.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot.color}`}
                title={dot.title}
                aria-label={dot.title}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {f.label}
                  {f.source === 'substack_auto' && (
                    <span
                      className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      title="Auto-imported from your Substack subscriptions"
                    >
                      Auto
                    </span>
                  )}
                  {!f.active && (
                    <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                      disabled
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {f.platform} · synced {relativeTime(f.lastSuccessAt)}
                  {f.lastItemCount != null && ` · ${f.lastItemCount} items`}
                </div>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                  title={f.url}
                >
                  {f.url}
                </a>
                {f.lastError && (
                  <div className="truncate text-xs text-destructive" title={f.lastError}>
                    {f.lastError}
                  </div>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" disabled={busyId === f.id}>
                    {busyId === f.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MoreVertical className="h-4 w-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => editLabel(f)}>
                    Edit label
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      patchFeed(
                        f.id,
                        { active: !f.active },
                        f.active ? 'Feed disabled' : 'Feed enabled',
                      )
                    }
                  >
                    {f.active ? 'Disable' : 'Enable'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
