import { describe, it, expect } from 'vitest'
import { mergeAwcPoll, hasActiveConversion } from './polling'
import type { QueueItem } from '@/lib/queue-client'

const item = (id: number, status: string | null): QueueItem => ({
  id, awcConversion: status ? { id: id * 10, status: status as never, error: null, requestedAt: 'r', updatedAt: 'u' } : null,
} as QueueItem)

describe('mergeAwcPoll', () => {
  it('advances an active item to the polled stage', () => {
    const { queue } = mergeAwcPoll([item(1, 'queued')], {
      conversions: [{ id: 10, contentItemId: 1, status: 'building_script', error: null, requestedAt: 'r', updatedAt: 'u2' }],
      heartbeatAgeSeconds: 3,
    })
    expect(queue[0].awcConversion?.status).toBe('building_script')
  })
  it('requests a refresh when a tracked conversion is done', () => {
    const r = mergeAwcPoll([item(1, 'generating')], {
      conversions: [{ id: 10, contentItemId: 1, status: 'done', error: null, requestedAt: 'r', updatedAt: 'u' }], heartbeatAgeSeconds: 3,
    })
    expect(r.needsRefresh).toBe(true)
    expect(r.queue[0].awcConversion).toBeNull()
  })
  it('surfaces failures with their error', () => {
    const r = mergeAwcPoll([item(1, 'starting')], {
      conversions: [{ id: 10, contentItemId: 1, status: 'failed', error: 'timeout', requestedAt: 'r', updatedAt: 'u' }], heartbeatAgeSeconds: 3,
    })
    expect(r.queue[0].awcConversion).toMatchObject({ status: 'failed', error: 'timeout' })
  })
  it('leaves untracked items untouched and flags a stale heartbeat', () => {
    const q = [item(2, null)]
    const r = mergeAwcPoll(q, { conversions: [], heartbeatAgeSeconds: 500 })
    expect(r.queue[0]).toBe(q[0])
    expect(r.agentStale).toBe(true)
    expect(mergeAwcPoll(q, { conversions: [], heartbeatAgeSeconds: null }).agentStale).toBe(true)
  })
  it('keeps an optimistic queued state when the poll has not seen the row yet', () => {
    const r = mergeAwcPoll([item(1, 'queued')], { conversions: [], heartbeatAgeSeconds: 3 })
    expect(r.queue[0].awcConversion?.status).toBe('queued')
  })
})

it('hasActiveConversion', () => {
  expect(hasActiveConversion([item(1, 'failed'), item(2, null)])).toBe(false)
  expect(hasActiveConversion([item(1, 'generating')])).toBe(true)
})

describe('mergeAwcPoll — retry races (#317 review)', () => {
  const row = (id: number, status: string) => ({ id, contentItemId: 1, status: status as never, error: status === 'failed' ? 'old' : null, requestedAt: 'r', updatedAt: 'u' })
  const local = (id: number, status: string) => ({ id: 1, awcConversion: { id, status: status as never, error: null, requestedAt: 'r', updatedAt: 'u' } }) as QueueItem

  it('keeps the optimistic queued state when the poll only sees the previous failed row', () => {
    const r = mergeAwcPoll([local(-1, 'queued')], { conversions: [row(10, 'failed')], heartbeatAgeSeconds: 3 })
    expect(r.queue[0].awcConversion).toMatchObject({ id: -1, status: 'queued' })
  })
  it('adopts the new active row once the poll sees it', () => {
    const r = mergeAwcPoll([local(-1, 'queued')], { conversions: [row(10, 'failed'), row(11, 'starting')], heartbeatAgeSeconds: 3 })
    expect(r.queue[0].awcConversion).toMatchObject({ id: 11, status: 'starting' })
  })
  it('ignores rows older than the conversion the card already tracks', () => {
    const r = mergeAwcPoll([local(11, 'queued')], { conversions: [row(10, 'failed')], heartbeatAgeSeconds: 3 })
    expect(r.queue[0].awcConversion).toMatchObject({ id: 11, status: 'queued' })
  })
})
