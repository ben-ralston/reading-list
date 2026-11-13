import { describe, it, expect } from 'vitest'
import { getEndpoint, ENDPOINTS } from './dispatch'

describe('cron dispatch', () => {
  it('returns the RSS endpoint for the */15 cron', () => {
    expect(getEndpoint('*/15 * * * *')).toBe('/api/cron/rss-sync')
  })

  it('returns the Spotify endpoint for the :15 cron', () => {
    expect(getEndpoint('15 * * * *')).toBe('/api/cron/spotify-sync')
  })

  it('returns the Substack import endpoint for the daily cron', () => {
    expect(getEndpoint('0 8 * * *')).toBe('/api/cron/substack-import')
  })

  it('maps the askwhocasts cron to the askwhocasts-sync endpoint', () => {
    expect(getEndpoint('5-59/15 * * * *')).toBe('/api/cron/askwhocasts-sync')
  })

  it('returns null for an unknown cron string', () => {
    expect(getEndpoint('0 0 * * *')).toBeNull()
  })

  it('exposes the dispatch table for inspection', () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(
      ['*/15 * * * *', '5-59/15 * * * *', '15 * * * *', '0 8 * * *'].sort(),
    )
  })
})
