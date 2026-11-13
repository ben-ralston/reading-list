import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddBookDialog } from './add-book-dialog'

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

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string)
}

const HIGH_META = {
  title: 'Atomic Habits',
  author: 'James Clear',
  subtitle: 'An Easy & Proven Way to Build Good Habits',
  isbn13: '9780735211292',
  goodreadsUrl: 'https://www.goodreads.com/book/show/40121378-atomic-habits',
  coverImageUrl: 'https://images.example.com/atomic.jpg',
  publishedOn: '2018-10-16',
  confidence: 'high',
}

async function lookUp(text: string) {
  const user = userEvent.setup()
  await user.type(screen.getByPlaceholderText(/paste a book url/i), text)
  await user.click(screen.getByRole('button', { name: /look up/i }))
}

describe('AddBookDialog', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    toastInfo.mockClear()
    mockFetch.mockReset()
  })

  it('auto-saves on high confidence without showing the form', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { metadata: HIGH_META, confidence: 'high' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { success: true, action: 'created', title: 'Atomic Habits' }),
      )

    const onOpenChange = vi.fn()
    const onAdded = vi.fn()
    render(<AddBookDialog open onOpenChange={onOpenChange} onAdded={onAdded} />)

    await lookUp('Atomic Habits')

    // Two calls: lookup, then add-entry.
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toBe('/api/books/lookup')
    expect(mockFetch.mock.calls[1][0]).toBe('/api/add-entry')

    const body = bodyOf(mockFetch.mock.calls[1])
    expect(body).toMatchObject({
      kind: 'book',
      platform: 'Goodreads',
      title: 'Atomic Habits',
      author: 'James Clear',
      link: HIGH_META.goodreadsUrl,
      isbn13: '9780735211292',
      subtitle: HIGH_META.subtitle,
      imageUrl: HIGH_META.coverImageUrl,
      publishedOn: '2018-10-16',
    })

    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(onAdded).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reveals a pre-filled form (Goodreads default) on low confidence', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        metadata: { title: 'Maybe Book', author: 'A. Writer', subtitle: 'A Subtitle', confidence: 'low' },
        confidence: 'low',
      }),
    )

    render(<AddBookDialog open onOpenChange={() => {}} />)
    await lookUp('maybe book')

    // Form is shown, pre-filled; add-entry was NOT auto-called.
    const title = await screen.findByPlaceholderText('Title')
    expect((title as HTMLInputElement).value).toBe('Maybe Book')
    expect((screen.getByPlaceholderText('Author') as HTMLInputElement).value).toBe('A. Writer')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('Goodreads')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to the form when the lookup request fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'))

    render(<AddBookDialog open onOpenChange={() => {}} />)
    await lookUp('Atomic Habits')

    // Graceful: the user still gets the editable form (typed text seeded as title).
    const title = await screen.findByPlaceholderText('Title')
    expect((title as HTMLInputElement).value).toBe('Atomic Habits')
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('lets the user skip lookup via the manual escape hatch', async () => {
    const user = userEvent.setup()
    render(<AddBookDialog open onOpenChange={() => {}} />)

    await user.click(screen.getByRole('button', { name: /enter manually/i }))

    const title = await screen.findByPlaceholderText('Title')
    expect((title as HTMLInputElement).value).toBe('')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('submits the form (including book metadata) to /api/add-entry', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        metadata: {
          title: 'Maybe Book',
          author: 'A. Writer',
          isbn13: '9781111111111',
          goodreadsUrl: 'https://www.goodreads.com/book/show/55-maybe',
          coverImageUrl: 'https://images.example.com/maybe.jpg',
          confidence: 'low',
        },
        confidence: 'low',
      }),
    )

    const onOpenChange = vi.fn()
    render(<AddBookDialog open onOpenChange={onOpenChange} />)
    await lookUp('maybe book')

    await screen.findByPlaceholderText('Title')

    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { success: true, action: 'created', title: 'Maybe Book' }),
    )
    await user.click(screen.getByRole('button', { name: /add book/i }))

    const addCall = mockFetch.mock.calls.find((c) => c[0] === '/api/add-entry')!
    const body = bodyOf(addCall)
    expect(body).toMatchObject({
      kind: 'book',
      platform: 'Goodreads',
      title: 'Maybe Book',
      author: 'A. Writer',
      isbn13: '9781111111111',
      imageUrl: 'https://images.example.com/maybe.jpg',
    })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
