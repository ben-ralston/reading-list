"use client"

// Shared text-search input (#283) used by the queue pages (via ReadingList)
// and the archive pages (via ArchiveList). Fully controlled; the parent owns
// the query. Escape and the × button both clear. Styling mirrors the raw
// <input> fields in the add-entry dialogs — there is no ui/input primitive.

import { Search, X } from "lucide-react"

interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}

export function SearchField({ value, onChange, placeholder, className = "" }: SearchFieldProps) {
  return (
    <div className={`relative ${className}`}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value !== '') {
            e.preventDefault()
            onChange('')
          }
        }}
        placeholder={placeholder}
        aria-label="Search by title or author"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
