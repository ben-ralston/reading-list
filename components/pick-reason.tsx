// Claude's one-line reason under a pick (#377). Plain text, one line, never
// wraps: the line is meant to stay quiet, and it is one JSX line at
// each use site, trivial to delete.
export function PickReason({ text, className = "" }: { text: string; className?: string }) {
  return (
    <p data-testid="pick-reason" className={`mt-1 truncate text-sm text-muted-foreground ${className}`}>
      {text}
    </p>
  )
}

// Marks an item in the Everything list that is currently on home (#377):
// filled and high-contrast, so picks are obvious at a glance.
export function PickPill() {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full bg-primary text-primary-foreground font-semibold"
      style={{ fontSize: "11px", letterSpacing: "0.06em" }}
    >
      PICK
    </span>
  )
}

// Marks an item added since the previous visit to Everything (#377).
export function NewPill() {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold"
      style={{ fontSize: "11px", letterSpacing: "0.06em" }}
    >
      NEW
    </span>
  )
}
