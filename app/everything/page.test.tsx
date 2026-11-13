import { describe, it, expect, vi, afterEach } from 'vitest'

const clientProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/app-settings', () => ({ getEverythingLastSeen: () => Promise.resolve('2026-11-09T00:00:00.000Z') }))
vi.mock('@/lib/content/queue-route', () => ({
  // The feed read takes "a minute": the clock moves while it runs.
  fetchFeedHome: async () => {
    vi.setSystemTime(Date.parse('2026-11-09T12:01:00Z'))
    return { items: [], curation: null }
  },
}))
vi.mock('./everything-client', () => ({
  EverythingClient: (props: Record<string, unknown>) => { clientProps.last = props; return null },
}))

import EverythingPage from './page'

afterEach(() => { vi.useRealTimers() })

describe('/everything page data (#377)', () => {
  it('takes the visit time before reading the feed, so nothing added mid-read counts as seen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-11-09T12:00:00Z'))
    const tree = await EverythingPage()
    const client = (tree as { props: { children: { props: Record<string, unknown> } } }).props.children
    expect(client.props.serverNow).toBe(Date.parse('2026-11-09T12:00:00Z'))
    expect(client.props.newSince).toBe('2026-11-09T00:00:00.000Z')
  })
})
