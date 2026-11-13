import { describe, it, expect, vi } from 'vitest'

// #189: the active-queue pages must read fresh DB state on every load, never a
// stale ISR snapshot that keeps a just-completed/skipped item in the queue.
// These page modules SSR-read Supabase and import heavy client component trees;
// mock both so the test can import them purely to assert route segment config.
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/app/home-client', () => ({ HomeClient: () => null }))
vi.mock('@/app/books/books-client', () => ({ BooksClient: () => null }))
vi.mock('@/app/everything/everything-client', () => ({ EverythingClient: () => null }))

describe('queue page caching config (#189)', () => {
  it('home (feed) queue page is force-dynamic, not ISR', async () => {
    const mod = await import('@/app/page')
    expect(mod.dynamic).toBe('force-dynamic')
    // The old `revalidate = 30` ISR snapshot is what served stale data.
    expect((mod as Record<string, unknown>).revalidate).toBeUndefined()
  })

  it('books queue page is force-dynamic, not ISR', async () => {
    const mod = await import('@/app/books/page')
    expect(mod.dynamic).toBe('force-dynamic')
    expect((mod as Record<string, unknown>).revalidate).toBeUndefined()
  })

  it('everything (feed pile) page is force-dynamic, not ISR (#377)', async () => {
    const mod = await import('@/app/everything/page')
    expect(mod.dynamic).toBe('force-dynamic')
    expect((mod as Record<string, unknown>).revalidate).toBeUndefined()
  })
})
