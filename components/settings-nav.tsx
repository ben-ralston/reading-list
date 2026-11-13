'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Settings cross-nav. Lives at the top of every /settings/* page.
// Adding `books-import` as part of #147 so the Goodreads import page
// participates in the same nav strip.

const LINKS = [
  { href: '/settings/feeds', label: 'Feeds' },
  { href: '/settings/status', label: 'Status' },
  { href: '/settings/books/import', label: 'Books import' },
  { href: '/settings/share', label: 'Share' },
  { href: '/settings/link-lab', label: 'Link lab' },
] as const

export function SettingsNav() {
  const pathname = usePathname()
  return (
    <nav className="flex items-center gap-4 text-sm">
      {LINKS.map((l) => {
        const active = pathname === l.href
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }
          >
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
