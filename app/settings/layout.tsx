import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { SettingsNav } from '@/components/settings-nav'

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Home
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-3 border-b border-border pb-2">
        <SettingsNav />
      </div>
      {children}
    </main>
  )
}
