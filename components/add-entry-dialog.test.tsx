import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddEntryDialog } from './add-entry-dialog'

// Mock sonner so we can assert exactly which toast variant fired. The whole
// point of #176 is that a non-create (or a failed write) must NEVER call
// toast.success.
const toastSuccess = vi.fn()
const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}))

// Mock the network layer so each test controls the server response.
const mockFetch = vi.fn()
vi.mock('@/lib/fetch-with-retry', () => ({
  fetchWithRetry: (...args: unknown[]) => mockFetch(...args),
}))

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

async function submitUrl(url: string) {
  const user = userEvent.setup()
  const input = screen.getByRole('textbox')
  await user.type(input, url)
  await user.click(screen.getByRole('button', { name: /add/i }))
}

describe('AddEntryDialog', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    toastInfo.mockClear()
    mockFetch.mockClear()
  })

  it('shows a success toast when the server reports a created entry', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { success: true, action: 'created', title: 'New', author: 'A' }),
    )

    render(<AddEntryDialog open onOpenChange={() => {}} />)
    await submitUrl('https://example.com/new')

    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('does NOT show a success toast for a dedup no-op (action: existing)', async () => {
    // The dangerous #176 case: a 200 that created nothing must never read as
    // "Entry submitted! It will appear shortly."
    mockFetch.mockResolvedValue(
      jsonResponse(200, { success: true, action: 'existing', title: 'Dup', author: 'A' }),
    )

    render(<AddEntryDialog open onOpenChange={() => {}} />)
    await submitUrl('https://example.com/dup')

    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledTimes(1)
    // And it must not promise the entry will appear.
    const message = String(toastInfo.mock.calls[0]?.[0] ?? '')
    expect(message.toLowerCase()).not.toContain('will appear')
  })

  it('shows an error toast (never success) when the write fails', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(500, { error: "Couldn't save the entry — please try again.", stage: 'insert' }),
    )

    render(<AddEntryDialog open onOpenChange={() => {}} />)
    await submitUrl('https://example.com/boom')

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
    const message = String(toastError.mock.calls[0]?.[0] ?? '')
    expect(message).toContain("Couldn't save the entry")
  })

  it('surfaces a metadata-fetch failure message distinctly', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(502, { error: "Couldn't read that link — it didn't respond or its details couldn't be read.", stage: 'metadata' }),
    )

    render(<AddEntryDialog open onOpenChange={() => {}} />)
    await submitUrl('https://example.com/slow')

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
    const message = String(toastError.mock.calls[0]?.[0] ?? '')
    expect(message).toContain("Couldn't read that link")
  })

  // #377: a hand-add is pinned server-side; the page reloads so it shows at once.
  it('calls onAdded after a created entry', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { success: true, action: 'created' }))
    const onAdded = vi.fn()
    render(<AddEntryDialog open onOpenChange={() => {}} onAdded={onAdded} />)
    await submitUrl('https://example.com/new')
    expect(onAdded).toHaveBeenCalledTimes(1)
  })

  it('does not call onAdded when the add fails', async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { error: 'nope' }))
    const onAdded = vi.fn()
    render(<AddEntryDialog open onOpenChange={() => {}} onAdded={onAdded} />)
    await submitUrl('https://example.com/new')
    expect(onAdded).not.toHaveBeenCalled()
  })
})
