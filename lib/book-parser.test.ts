import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the Anthropic SDK so we control what messages.create returns per test.
// vi.hoisted lets the test body reconfigure the same mock the factory installs.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate }
  }
  return { default: MockAnthropic }
})

import { parseBook } from './book-parser'

/** Build an Anthropic-shaped response whose text block is `text`. */
function textResponse(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
}

/** Build a response whose text block is the JSON-encoded `obj`. */
function jsonResponse(obj: unknown) {
  return textResponse(JSON.stringify(obj))
}

const FULL_BOOK = {
  title: 'Atomic Habits',
  author: 'James Clear',
  subtitle: 'An Easy & Proven Way to Build Good Habits & Break Bad Ones',
  series: '',
  isbn13: '9780735211292',
  goodreadsUrl: 'https://www.goodreads.com/book/show/40121378-atomic-habits',
  coverImageUrl: 'https://images.example.com/atomic.jpg',
  publishedOn: '2018-10-16',
  confidence: 'high',
}

describe('parseBook', () => {
  beforeEach(() => {
    mockCreate.mockReset()
    process.env.ANTHROPIC_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY
  })

  describe('free-text input', () => {
    it('returns full metadata and high confidence for a clear match', async () => {
      mockCreate.mockResolvedValue(jsonResponse(FULL_BOOK))

      const result = await parseBook('Atomic Habits James Clear')

      expect(result.title).toBe('Atomic Habits')
      expect(result.author).toBe('James Clear')
      expect(result.subtitle).toBe(FULL_BOOK.subtitle)
      expect(result.isbn13).toBe('9780735211292')
      expect(result.goodreadsUrl).toBe(FULL_BOOK.goodreadsUrl)
      expect(result.coverImageUrl).toBe(FULL_BOOK.coverImageUrl)
      expect(result.publishedOn).toBe('2018-10-16')
      expect(result.confidence).toBe('high')
    })

    it('uses the agentic web_search tool', async () => {
      mockCreate.mockResolvedValue(jsonResponse(FULL_BOOK))

      await parseBook('Atomic Habits')

      const callArgs = mockCreate.mock.calls[0][0]
      expect(callArgs.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'web_search_20250305' })]),
      )
    })

    it('parses JSON even when the model wraps it in prose', async () => {
      mockCreate.mockResolvedValue(
        textResponse(`Here is what I found:\n${JSON.stringify(FULL_BOOK)}\nHope that helps!`),
      )

      const result = await parseBook('Atomic Habits')
      expect(result.title).toBe('Atomic Habits')
      expect(result.confidence).toBe('high')
    })
  })

  describe('URL input', () => {
    it('treats a pasted Goodreads book URL as high confidence and adds web_fetch', async () => {
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, confidence: 'low' }))

      const result = await parseBook(
        'https://www.goodreads.com/book/show/40121378-atomic-habits',
      )

      // A pasted canonical book page is strong signal: a recognized book-source
      // URL biases to high even when the model self-reports low, as long as
      // title + author resolved.
      expect(result.confidence).toBe('high')

      const callArgs = mockCreate.mock.calls[0][0]
      expect(callArgs.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'web_fetch_20250910' })]),
      )
    })

    it('upgrades an Amazon product page but NOT an Amazon search page', async () => {
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, confidence: 'low' }))
      const product = await parseBook('https://www.amazon.com/Atomic-Habits/dp/0735211299')
      expect(product.confidence).toBe('high')

      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, confidence: 'low' }))
      const search = await parseBook('https://www.amazon.com/s?k=atomic+habits')
      // A search page is not a specific book — preserve the model's confidence.
      expect(search.confidence).toBe('low')
    })

    it('upgrades an Open Library book page', async () => {
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, confidence: 'low' }))
      const result = await parseBook('https://openlibrary.org/works/OL45804W/Atomic_Habits')
      expect(result.confidence).toBe('high')
    })

    it('does NOT force high for a Goodreads search/listing URL', async () => {
      // Symmetric to the Amazon search case: only /book/show/ pages upgrade.
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, confidence: 'low' }))
      const result = await parseBook('https://www.goodreads.com/search?q=atomic+habits')
      expect(result.confidence).toBe('low')
    })

    it('does NOT force high confidence for a non-book URL when the model says low', async () => {
      // The core RLV-002 bug: any http(s) URL used to force high → junk auto-save.
      // A blog post URL is not a book source, so the model's 'low' must survive.
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, confidence: 'low' }))

      const result = await parseBook('https://example.com/some-blog-post')
      expect(result.confidence).toBe('low')
    })

    it('still trusts the model when a non-book URL genuinely resolves to a book', async () => {
      // We only remove the forced upgrade — a model that confidently identifies a
      // book from any URL still reports high, and we preserve it.
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, confidence: 'high' }))

      const result = await parseBook('https://example.com/some-blog-post')
      expect(result.confidence).toBe('high')
    })
  })

  describe('server-authoritative confidence', () => {
    it('forces low confidence when the author is missing, even if the model says high', async () => {
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, author: '', confidence: 'high' }))

      const result = await parseBook('Some ambiguous title')
      expect(result.confidence).toBe('low')
    })

    it('forces low confidence for a degenerate title', async () => {
      mockCreate.mockResolvedValue(
        jsonResponse({ ...FULL_BOOK, title: '- YouTube', confidence: 'high' }),
      )

      const result = await parseBook('garbage')
      expect(result.confidence).toBe('low')
    })
  })

  describe('publishedOn handling', () => {
    it('expands a year-only publish date to Jan 1 (books often have only a year)', async () => {
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, publishedOn: '2018' }))
      const result = await parseBook('Atomic Habits')
      expect(result.publishedOn).toBe('2018-01-01')
    })

    it('keeps a full YYYY-MM-DD date as-is', async () => {
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, publishedOn: '2018-10-16' }))
      const result = await parseBook('Atomic Habits')
      expect(result.publishedOn).toBe('2018-10-16')
    })

    it('drops an unparseable date', async () => {
      mockCreate.mockResolvedValue(jsonResponse({ ...FULL_BOOK, publishedOn: 'sometime in 2018' }))
      const result = await parseBook('Atomic Habits')
      expect(result.publishedOn).toBeUndefined()
    })
  })

  describe('Goodreads junk-URL guard', () => {
    it('drops a search URL rather than storing it as the Goodreads link', async () => {
      mockCreate.mockResolvedValue(
        jsonResponse({
          ...FULL_BOOK,
          goodreadsUrl: 'https://www.goodreads.com/search?q=atomic+habits',
        }),
      )

      const result = await parseBook('Atomic Habits')
      expect(result.goodreadsUrl).toBeUndefined()
    })

    it('keeps a canonical /book/show/ URL', async () => {
      mockCreate.mockResolvedValue(jsonResponse(FULL_BOOK))

      const result = await parseBook('Atomic Habits')
      expect(result.goodreadsUrl).toBe(FULL_BOOK.goodreadsUrl)
    })
  })

  describe('graceful degradation (never throws)', () => {
    it('returns a low-confidence stub when the model returns no JSON', async () => {
      mockCreate.mockResolvedValue(textResponse('I could not find that book.'))

      const result = await parseBook('Atomic Habits')
      expect(result.confidence).toBe('low')
      // Free-text input is echoed back as a best-effort title for the form.
      expect(result.title).toBe('Atomic Habits')
    })

    it('returns a low-confidence stub when the Anthropic call rejects', async () => {
      mockCreate.mockRejectedValue(new Error('network down'))

      const result = await parseBook('Atomic Habits')
      expect(result.confidence).toBe('low')
      expect(result.title).toBe('Atomic Habits')
    })

    it('returns a low-confidence stub when no API key is configured', async () => {
      delete process.env.ANTHROPIC_API_KEY
      mockCreate.mockResolvedValue(jsonResponse(FULL_BOOK))

      const result = await parseBook('Atomic Habits')
      expect(result.confidence).toBe('low')
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('does not echo a raw URL as the title on failure', async () => {
      mockCreate.mockRejectedValue(new Error('boom'))

      const result = await parseBook('https://www.goodreads.com/book/show/123')
      expect(result.title).toBe('')
      expect(result.confidence).toBe('low')
    })
  })
})
