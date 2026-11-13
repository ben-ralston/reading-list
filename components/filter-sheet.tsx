"use client"

// #241: single-button filter surface. FilterSheet = funnel trigger with an
// active-count badge opening a bottom sheet; FilterSummaryChips echoes active
// filters as dismissible chips under the toolbar. All filter logic lives in
// lib/use-queue-filters.ts — these components only render props and fire the
// same callbacks ReadingList already receives.

import { useState } from "react"
import { ListFilter } from "lucide-react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogClose } from "./ui/dialog"
import { type MediaFilter } from "@/lib/media-type"
import { type AuthorOption } from "@/lib/author-filter"
import { type ReadState, type ReadStateOption } from "@/lib/read-state"
import { activeSheetFilterCount } from "@/lib/sheet-filter-count"

// Mirrors the filter slice of ReadingListProps exactly — ReadingList spreads
// its own props straight through, so this interface must not drift from it.
export interface FilterControlProps {
  mediaFilter: MediaFilter
  onMediaFilterChange: (filter: MediaFilter) => void
  mediaCounts: { all: number; audio: number; text: number }
  authorOptions: AuthorOption[]
  selectedAuthors: string[]
  onSelectedAuthorsChange: (labels: string[]) => void
  readStateOptions: ReadStateOption[]
  selectedReadStates: ReadState[]
  onSelectedReadStatesChange: (states: ReadState[]) => void
}

export function FilterSheet(props: FilterControlProps) {
  const { mediaFilter, selectedAuthors, selectedReadStates } = props
  const [open, setOpen] = useState(false)

  const activeCount = activeSheetFilterCount(mediaFilter, selectedReadStates, selectedAuthors)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1 px-2 py-1 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors ${
          activeCount > 0 ? 'text-primary' : 'text-muted-foreground'
        }`}
        aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : 'Filters'}
        data-filters-active={activeCount > 0}
      >
        <ListFilter className="h-3.5 w-3.5" />
        {activeCount > 0 && (
          <span className="text-[10px] font-semibold leading-none">{activeCount}</span>
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed bottom-0 left-1/2 z-50 flex max-h-[85dvh] w-full max-w-md -translate-x-1/2 flex-col rounded-t-2xl border-t bg-background p-4 pb-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom duration-200"
          >
            <DialogTitle className="sr-only">Filters</DialogTitle>
            <div aria-hidden className="mx-auto mb-4 h-1 w-9 rounded-full bg-muted shrink-0" />
            {/* Scrollable body: on short viewports (landscape phone) the sheet
                is height-capped and sections scroll instead of overflowing
                off the top edge (review finding). */}
            <div data-sheet-body className="min-h-0 flex-1 overflow-y-auto">
            <div className="mb-4">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Media
              </p>
              <div className="inline-flex rounded-full bg-secondary p-0.5">
                {(['all', 'audio', 'text'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => props.onMediaFilterChange(filter)}
                    aria-pressed={mediaFilter === filter}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                      mediaFilter === filter
                        ? 'bg-primary text-primary-foreground'
                        : 'text-secondary-foreground hover:bg-accent'
                    }`}
                  >
                    {filter === 'all' ? 'All' : filter === 'audio' ? 'Audio' : 'Text'} ({props.mediaCounts[filter]})
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-4">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Status
              </p>
              <div className="flex flex-wrap gap-2">
                {props.readStateOptions.map((option) => {
                  const selected = selectedReadStates.includes(option.key)
                  return (
                    <button
                      key={option.key}
                      aria-pressed={selected}
                      onClick={() =>
                        props.onSelectedReadStatesChange(
                          selected
                            ? selectedReadStates.filter((state) => state !== option.key)
                            : [...selectedReadStates, option.key],
                        )
                      }
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                        selected
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-secondary-foreground hover:bg-accent'
                      }`}
                    >
                      {option.label} ({option.count})
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mb-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Authors
              </p>
              {/* pr-3 keeps the count column clear of iOS's overlay scrollbar,
                  which paints inside the scroll container's right edge. */}
              <div className="max-h-56 overflow-y-auto pr-3">
                {props.authorOptions.map((option) => {
                  const selected = selectedAuthors.includes(option.label)
                  return (
                    <label
                      key={option.key}
                      className="flex cursor-pointer items-center gap-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={selected}
                        onChange={() =>
                          props.onSelectedAuthorsChange(
                            selected
                              ? selectedAuthors.filter((label) => label !== option.label)
                              : [...selectedAuthors, option.label],
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 truncate" title={option.label}>
                        {option.label}
                      </span>
                      <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
                        {option.count}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
            </div>
            <div className="mt-4 flex shrink-0 gap-2 border-t pt-4">
              <button
                disabled={activeCount === 0}
                onClick={() => {
                  props.onMediaFilterChange('all')
                  props.onSelectedAuthorsChange([])
                  props.onSelectedReadStatesChange([])
                }}
                className="flex-1 rounded-full border py-2 text-sm text-secondary-foreground disabled:opacity-50"
              >
                Clear all
              </button>
              <DialogClose asChild>
                <button className="flex-[1.4] rounded-full bg-primary py-2 text-sm font-semibold text-primary-foreground">
                  Done
                </button>
              </DialogClose>
            </div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </>
  )
}

const MEDIA_LABELS: Record<Exclude<MediaFilter, 'all'>, string> = {
  audio: 'Audio',
  text: 'Text',
}

// Dismissible echo of active filters, shown under the toolbar while the
// sheet is closed. Renders null when nothing is active.
export function FilterSummaryChips(props: FilterControlProps) {
  const { mediaFilter, selectedAuthors, selectedReadStates } = props
  const activeCount = activeSheetFilterCount(mediaFilter, selectedReadStates, selectedAuthors)
  if (activeCount === 0) return null

  const stateLabel = (key: ReadState) =>
    props.readStateOptions.find((option) => option.key === key)?.label ?? key

  const chipClass =
    'flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-sm font-medium'

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {mediaFilter !== 'all' && (
        <button
          aria-label={`Remove filter ${MEDIA_LABELS[mediaFilter]}`}
          onClick={() => props.onMediaFilterChange('all')}
          className={chipClass}
        >
          <span>{MEDIA_LABELS[mediaFilter]}</span>
          <span aria-hidden className="opacity-60">✕</span>
        </button>
      )}
      {selectedReadStates.map((key) => (
        <button
          key={key}
          aria-label={`Remove filter ${stateLabel(key)}`}
          onClick={() =>
            props.onSelectedReadStatesChange(selectedReadStates.filter((s) => s !== key))
          }
          className={chipClass}
        >
          <span>{stateLabel(key)}</span>
          <span aria-hidden className="opacity-60">✕</span>
        </button>
      ))}
      {selectedAuthors.map((label) => (
        <button
          key={label}
          aria-label={`Remove filter ${label}`}
          onClick={() =>
            props.onSelectedAuthorsChange(selectedAuthors.filter((l) => l !== label))
          }
          className={chipClass}
        >
          <span className="max-w-[9rem] truncate" title={label}>{label}</span>
          <span aria-hidden className="opacity-60">✕</span>
        </button>
      ))}
      <button
        aria-label="Clear all filters"
        onClick={() => {
          props.onMediaFilterChange('all')
          props.onSelectedAuthorsChange([])
          props.onSelectedReadStatesChange([])
        }}
        className="px-2 py-1.5 text-sm text-muted-foreground underline underline-offset-4"
      >
        Clear all
      </button>
    </div>
  )
}
