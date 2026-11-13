// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createMaintenance, type MaintenanceDeps } from './maintenance'

function deps(over: Partial<MaintenanceDeps> = {}): MaintenanceDeps {
  return {
    writeHeartbeat: vi.fn().mockResolvedValue(undefined),
    countRecentGenerating: vi.fn().mockResolvedValue(0),
    nudger: { maybeNudge: vi.fn().mockResolvedValue(false) },
    ulog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    statusLine: vi.fn(),
    nowMs: () => Date.parse('2026-10-04T12:00:00Z'),
    ...over,
  }
}

describe('maintenance.tick', () => {
  it('writes the heartbeat and logs the line a log watcher watches', async () => {
    const d = deps()
    await createMaintenance(d).tick()
    expect(d.writeHeartbeat).toHaveBeenCalledWith('2026-10-04T12:00:00.000Z')
    expect(d.statusLine).toHaveBeenCalledWith('heartbeat ok 2026-10-04T12:00:00.000Z')
  })

  it('nudges the sync with the count of recently generating rows (45 min window)', async () => {
    const d = deps({ countRecentGenerating: vi.fn().mockResolvedValue(2) })
    await createMaintenance(d).tick()
    expect(d.countRecentGenerating).toHaveBeenCalledWith('2026-10-04T11:15:00.000Z')
    expect(d.nudger.maybeNudge).toHaveBeenCalledWith(2)
  })

  // #366: a short blip warns and prints one "retrying" line; after that the
  // log goes quiet, so a missing "heartbeat ok" trips a log watcher's 3-minute
  // staleness check.
  const blip = () => new Error('TypeError: fetch failed')
  it('warns and prints a retrying line when the heartbeat write fails, and still nudges', async () => {
    const d = deps({ writeHeartbeat: vi.fn().mockRejectedValue(blip()), countRecentGenerating: vi.fn().mockResolvedValue(1) })
    await createMaintenance(d).tick()
    expect(d.ulog.warn).toHaveBeenCalledWith('awc heartbeat failed', { error: 'TypeError: fetch failed' })
    expect(d.ulog.error).not.toHaveBeenCalled()
    expect(d.statusLine).toHaveBeenCalledWith('heartbeat retrying: TypeError: fetch failed')
    expect(d.nudger.maybeNudge).toHaveBeenCalledWith(1)
  })

  it('escalates heartbeat failures to one error and FAILED lines after 10 minutes, quiet in between', async () => {
    let now = Date.parse('2026-10-04T12:00:00Z')
    const d = deps({ writeHeartbeat: vi.fn().mockRejectedValue(blip()), nowMs: () => now })
    const m = createMaintenance(d)
    for (let i = 0; i <= 11; i++) {
      await m.tick()
      now += 60_000
    }
    expect(d.ulog.error).toHaveBeenCalledTimes(1)
    expect(d.ulog.error).toHaveBeenCalledWith('awc heartbeat failed', { error: 'TypeError: fetch failed', failures: 11, failingForSec: 600 })
    expect(vi.mocked(d.statusLine).mock.calls.map((c) => c[0])).toEqual([
      'heartbeat retrying: TypeError: fetch failed',
      'heartbeat FAILED: TypeError: fetch failed',
      'heartbeat FAILED: TypeError: fetch failed',
    ])
  })

  it('logs a non-network heartbeat error as an error at once, with a FAILED line', async () => {
    const d = deps({ writeHeartbeat: vi.fn().mockRejectedValue({ message: 'JWT expired', code: 'PGRST301' }) })
    await createMaintenance(d).tick()
    expect(d.ulog.error).toHaveBeenCalledWith('awc heartbeat failed', { error: 'JWT expired (code: PGRST301)' })
    expect(d.statusLine).toHaveBeenCalledWith('heartbeat FAILED: JWT expired (code: PGRST301)')
  })

  it('logs heartbeat recovery once', async () => {
    let now = Date.parse('2026-10-04T12:00:00Z')
    const d = deps({ writeHeartbeat: vi.fn().mockRejectedValueOnce(blip()).mockResolvedValue(undefined), nowMs: () => now })
    const m = createMaintenance(d)
    for (let i = 0; i < 6; i++) { await m.tick(); now += 60_000 }
    expect(d.ulog.info).toHaveBeenCalledTimes(1)
    expect(d.ulog.info).toHaveBeenCalledWith('awc heartbeat recovered', expect.objectContaining({ failures: 1 }))
  })

  it('skips a tick while the previous one is still running (no pile-up on a hung call)', async () => {
    let release: () => void = () => {}
    const d = deps({ writeHeartbeat: vi.fn(() => new Promise<void>((r) => { release = r })) })
    const m = createMaintenance(d)
    const first = m.tick()
    await m.tick()
    expect(d.writeHeartbeat).toHaveBeenCalledTimes(1)
    release()
    await first
  })
})
