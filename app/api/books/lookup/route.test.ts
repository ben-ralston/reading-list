import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import type { BookMetadata } from '@/lib/book-parser'

const mockParseBook = vi.fn()
vi.mock('@/lib/book-parser', () => ({
  parseBook: (...args: unknown[]) => mockParseBook(...args),
}))

function createRequest(body: unknown): Request {
  return new Request('http://localhost/api/books/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const HIGH: BookMetadata = {
  title: 'Atomic Habits',
  author: 'James Clear',
  isbn13: '9780735211292',
  goodreadsUrl: 'https://www.goodreads.com/book/show/40121378-atomic-habits',
  coverImageUrl: 'https://images.example.com/atomic.jpg',
  confidence: 'high',
}

describe('POST /api/books/lookup', () => {
  beforeEach(() => {
    mockParseBook.mockReset()
  })

  it('rejects an empty input', async () => {
    const response = await POST(createRequest({ input: '' }))
    expect(response.status).toBe(400)
    expect(mockParseBook).not.toHaveBeenCalled()
  })

  it('rejects a missing/non-string input', async () => {
    expect((await POST(createRequest({}))).status).toBe(400)
    expect((await POST(createRequest({ input: 123 }))).status).toBe(400)
  })

  it('trims the input before looking up', async () => {
    mockParseBook.mockResolvedValue(HIGH)
    await POST(createRequest({ input: '  Atomic Habits  ' }))
    expect(mockParseBook).toHaveBeenCalledWith('Atomic Habits')
  })

  it('returns metadata + high confidence (no DB write)', async () => {
    mockParseBook.mockResolvedValue(HIGH)

    const response = await POST(createRequest({ input: 'Atomic Habits' }))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.confidence).toBe('high')
    expect(data.metadata.title).toBe('Atomic Habits')
    expect(data.metadata.goodreadsUrl).toBe(HIGH.goodreadsUrl)
  })

  it('returns 200 (not an error) for a low-confidence result', async () => {
    mockParseBook.mockResolvedValue({ title: 'Maybe', author: '', confidence: 'low' })

    const response = await POST(createRequest({ input: 'something obscure' }))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.confidence).toBe('low')
  })

  it('returns a 200 low-confidence stub if parseBook unexpectedly throws', async () => {
    mockParseBook.mockRejectedValue(new Error('unexpected'))

    const response = await POST(createRequest({ input: 'Atomic Habits' }))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.confidence).toBe('low')
  })

  it('returns 400 on an invalid JSON body', async () => {
    const badRequest = new Request('http://localhost/api/books/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect((await POST(badRequest)).status).toBe(400)
  })
})
