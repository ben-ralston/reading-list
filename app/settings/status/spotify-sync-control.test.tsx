import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockFetchWithRetry = vi.fn()
vi.mock('@/lib/fetch-with-retry', () => ({
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
}))

const mockRefresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import { toast } from 'sonner'
import { LAST_SPOTIFY_SYNC_KEY } from '@/lib/spotify/sync-cooldown'
import { SpotifySyncControl } from './spotify-sync-control'

function resolveWith(result: Record<string, unknown>, ok = true) {
  mockFetchWithRetry.mockResolvedValue({ ok, json: async () => result })
}

describe('SpotifySyncControl', () => {
  beforeEach(() => {
    mockFetchWithRetry.mockReset()
    mockRefresh.mockReset()
    vi.mocked(toast.info).mockReset()
    localStorage.clear()
  })

  it('calls the spotify-sync endpoint without retries when clicked', async () => {
    resolveWith({ success: true, processed: 0, created: 0, updated: 0, skipped: 0 })
    render(<SpotifySyncControl />)

    await userEvent.click(screen.getByRole('button'))

    await waitFor(() =>
      expect(mockFetchWithRetry).toHaveBeenCalledWith('/api/cron/spotify-sync', undefined, {
        retries: 0,
      }),
    )
  })

  it('refreshes the page when the sync created or updated items', async () => {
    resolveWith({ success: true, processed: 2, created: 2, updated: 0, skipped: 0 })
    render(<SpotifySyncControl />)

    await userEvent.click(screen.getByRole('button'))

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))
  })

  it('does not refresh when nothing changed', async () => {
    resolveWith({ success: true, processed: 0, created: 0, updated: 0, skipped: 0 })
    render(<SpotifySyncControl />)

    await userEvent.click(screen.getByRole('button'))

    // Wait for the handler to finish (button reports the no-change result via toast.info).
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('records the cooldown timestamp on success so the home auto-sync is suppressed', async () => {
    resolveWith({ success: true, processed: 0, created: 0, updated: 0, skipped: 0 })
    render(<SpotifySyncControl />)

    await userEvent.click(screen.getByRole('button'))

    await waitFor(() => expect(localStorage.getItem(LAST_SPOTIFY_SYNC_KEY)).not.toBeNull())
  })

  it('does not record the cooldown timestamp when the sync fails', async () => {
    resolveWith({ success: false, processed: 0, created: 0, updated: 0, skipped: 0, error: 'boom' })
    render(<SpotifySyncControl />)

    await userEvent.click(screen.getByRole('button'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(localStorage.getItem(LAST_SPOTIFY_SYNC_KEY)).toBeNull()
  })
})
