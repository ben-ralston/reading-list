import { describe, it, expect, vi } from 'vitest'

// #288: Next.js page modules may only export the default component, route
// segment config, and metadata/viewport. `app/page.tsx` re-exported runtime
// helpers for "backwards compatibility", which compiled fine but broke the
// production build at the page-module type check (`Property 'hasMediaType' is
// incompatible with index signature`). Type-only re-exports are erased and
// stay allowed.
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/app/home-client', () => ({ HomeClient: () => null }))
vi.mock('@/app/everything/everything-client', () => ({ EverythingClient: () => null }))

// Mirrors the `checkFields` allowlist Next.js generates in `.next/types/app/page.ts`
// (route segment config + metadata/viewport + a few internal knobs).
const ALLOWED_PAGE_EXPORTS = new Set([
  'default',
  'config',
  'instant',
  'prefetch',
  'unstable_dynamicStaleTime',
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'generateStaticParams',
  'generateMetadata',
  'metadata',
  'generateViewport',
  'viewport',
])

describe('home page module exports (#288)', () => {
  it('exports only what Next.js permits on a page module', async () => {
    const mod = await import('@/app/page')
    const unexpected = Object.keys(mod).filter((name) => !ALLOWED_PAGE_EXPORTS.has(name))
    expect(unexpected).toEqual([])
  })
})

describe('everything page module exports (#377)', () => {
  it('exports only what Next.js permits on a page module', async () => {
    const mod = await import('@/app/everything/page')
    const unexpected = Object.keys(mod).filter((name) => !ALLOWED_PAGE_EXPORTS.has(name))
    expect(unexpected).toEqual([])
  })
})
