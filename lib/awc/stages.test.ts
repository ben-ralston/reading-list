import { describe, it, expect } from 'vitest'
import { latestConversionSummary, summaryFromDb, awcBadgeLabel, isAgentStage, isActiveStage, isAwcSignedOut, isShortEpisode, type AwcConversionDB } from './stages'

const row = (o: Partial<AwcConversionDB>): AwcConversionDB => ({
  id: 1, status: 'queued', error: null,
  requested_at: '2026-10-04T12:00:00Z', updated_at: '2026-10-04T12:00:00Z', ...o,
})

describe('latestConversionSummary', () => {
  it('returns null for no rows', () => expect(latestConversionSummary(undefined)).toBeNull())
  it('picks the highest id', () => {
    expect(latestConversionSummary([row({ id: 1, status: 'failed' }), row({ id: 2, status: 'generating' })])?.status).toBe('generating')
  })
  it('hides done conversions', () => expect(latestConversionSummary([row({ status: 'done' })])).toBeNull())
  it('keeps failed so the card can offer Retry', () => expect(latestConversionSummary([row({ status: 'failed', error: 'x' })])?.error).toBe('x'))
  it('drops rows with an unknown status', () => expect(latestConversionSummary([row({ status: 'bogus' })])).toBeNull())
})

describe('awcBadgeLabel', () => {
  const now = Date.parse('2026-10-04T12:05:00Z')
  const s = (status: string) => latestConversionSummary([row({ status })])!
  it.each([
    ['queued', 'Queued'], ['starting', 'Starting'], ['submitting_url', 'Submitting'],
    ['building_script', 'Writing script'], ['generating', 'Recording'], ['failed', 'Failed'],
  ])('%s → %s', (status, label) => expect(awcBadgeLabel(s(status), false, now)).toBe(label))
  it('flags Mac offline when queued > 60 s and heartbeat stale', () => {
    expect(awcBadgeLabel(s('queued'), true, now)).toBe('Queued · Mac offline')
  })
  it('does not flag offline for a fresh request', () => {
    expect(awcBadgeLabel(s('queued'), true, Date.parse('2026-10-04T12:00:30Z'))).toBe('Queued')
  })
  // #339: the reason must be visible on the phone, not only in a tooltip.
  it.each([
    'not signed in to askwhocasts.com',
    'not signed in to app.askwhocasts.com',
    'Not signed in to AWC',
  ])('says "AWC signed out" for a failed row with %j', (error) => {
    expect(awcBadgeLabel(latestConversionSummary([row({ status: 'failed', error })])!, false, now)).toBe('AWC signed out')
  })
  it('keeps "Failed" when an article site (not AWC) is signed out', () => {
    expect(awcBadgeLabel(latestConversionSummary([row({ status: 'failed', error: 'not signed in to substack.com' })])!, false, now)).toBe('Failed')
  })
})

describe('short episode (#363)', () => {
  const warning = 'short episode: 5 credits for about 3,542 words'
  const now = Date.parse('2026-10-04T12:05:00Z')
  it('keeps a done row that carries the warning, so the card can show it', () => {
    expect(latestConversionSummary([row({ status: 'done', error: warning })])?.error).toBe(warning)
  })
  it('still hides a done row with any other error', () => {
    expect(latestConversionSummary([row({ status: 'done', error: 'agent timed out' })])).toBeNull()
  })
  it.each(['generating', 'done'])('labels a %s row "Short episode"', (status) => {
    expect(awcBadgeLabel(latestConversionSummary([row({ status, error: warning })])!, false, now)).toBe('Short episode')
  })
  // failed rows hold agent-influenced text, which must not earn the calmer pill.
  it('keeps "Failed" for a failed row whose error merely starts the same way', () => {
    const failed = latestConversionSummary([row({ status: 'failed', error: warning })])!
    expect(isShortEpisode(failed)).toBe(false)
    expect(awcBadgeLabel(failed, false, now)).toBe('Failed')
  })
  // markDoneForItem can move a failed row to done, keeping its agent-influenced
  // error, so the status check alone isn't enough.
  it('only accepts the exact format the daemon writes', () => {
    expect(isShortEpisode({ status: 'done', error: warning })).toBe(true)
    expect(isShortEpisode({ status: 'done', error: 'short episode: 12 credits for about 900 words' })).toBe(true)
    expect(isShortEpisode({ status: 'done', error: 'short episode: click here to fix your account' })).toBe(false)
    expect(isShortEpisode({ status: 'done', error: `${warning} and more` })).toBe(false)
  })
  it('isShortEpisode ignores other errors and missing rows', () => {
    expect(isShortEpisode({ status: 'generating', error: 'x' })).toBe(false)
    expect(isShortEpisode({ status: 'done', error: null })).toBe(false)
    expect(isShortEpisode(null)).toBe(false)
  })
})

describe('isAwcSignedOut', () => {
  it('matches only AWC sign-in errors', () => {
    expect(isAwcSignedOut('not signed in to askwhocasts.com')).toBe(true)
    expect(isAwcSignedOut('not signed in to www.askwhocasts.com')).toBe(true)
    expect(isAwcSignedOut('not signed in to substack.com')).toBe(false)
    expect(isAwcSignedOut('not signed in to evilaskwhocasts.com')).toBe(false)
    expect(isAwcSignedOut('AWC error: not signed in to AWC')).toBe(false)
    expect(isAwcSignedOut('not signed in to awc-news.com')).toBe(false)
    expect(isAwcSignedOut('not signed in to askwhocasts.com.example.net')).toBe(false)
    expect(isAwcSignedOut('not signed in to askwhocasts.com.')).toBe(true)
    expect(isAwcSignedOut(null)).toBe(false)
  })
})

describe('stage guards', () => {
  it('only the three agent stages are agent-settable', () => {
    expect(['submitting_url', 'building_script', 'generating'].every(isAgentStage)).toBe(true)
    expect(['queued', 'starting', 'done', 'failed', 'rm -rf'].some(isAgentStage)).toBe(false)
  })
  it('active = queued..generating', () => {
    expect(isActiveStage('generating')).toBe(true)
    expect(isActiveStage('failed')).toBe(false)
    expect(isActiveStage(null)).toBe(false)
  })
})

describe('comments conversions (#368)', () => {
  const row = { id: 1, status: 'generating', error: null, requested_at: 'r', updated_at: 'u', kind: 'comments' }
  it('carries the kind through summaryFromDb', () => {
    expect(summaryFromDb(row).kind).toBe('comments')
  })
  it.each([
    ['too few comments yet', 'Comments: Too few yet'],
    ['over credit cap', 'Comments: Over credit cap'],
  ])('names the expected stop %s, because iOS shows no tooltip', (error, label) => {
    expect(awcBadgeLabel(summaryFromDb({ ...row, status: 'failed', error }), false, 0)).toBe(label)
  })
  it('still says Failed for anything else', () => {
    expect(awcBadgeLabel(summaryFromDb({ ...row, status: 'failed', error: 'could not read comments' }), false, 0)).toBe('Comments: Failed')
  })
  it('prefixes the badge for comments conversions only', () => {
    const summary = summaryFromDb(row)
    expect(awcBadgeLabel(summary, false, 0)).toBe('Comments: Recording')
    expect(awcBadgeLabel({ ...summary, kind: 'article' }, false, 0)).toBe('Recording')
    expect(awcBadgeLabel({ ...summary, kind: undefined }, false, 0)).toBe('Recording')
  })
})
