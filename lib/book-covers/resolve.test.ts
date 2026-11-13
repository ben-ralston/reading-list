import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveBookCover, fromOpenLibrary, fromGoogleBooks } from './resolve'

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response
}

// Route a mocked fetch by URL so call order doesn't matter.
function mockFetch(routes: { openlibrary?: unknown; google?: unknown; throwAll?: boolean }) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (routes.throwAll) throw new TypeError('network down')
    if (url.includes('openlibrary.org')) return jsonResponse(routes.openlibrary ?? { docs: [] })
    if (url.includes('googleapis.com')) return jsonResponse(routes.google ?? { items: [] })
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveBookCover', () => {
  it('uses Open Library first and returns its cover + isbn13', async () => {
    const fetchMock = mockFetch({
      openlibrary: { docs: [{ cover_i: 123, isbn: ['080213825X', '9780802138256'] }] },
    })
    const result = await resolveBookCover('Snow Crash', 'Neal Stephenson')
    expect(result).toEqual({
      imageUrl: 'https://covers.openlibrary.org/b/id/123-L.jpg',
      isbn13: '9780802138256',
      source: 'openlibrary',
    })
    // Open Library hit → Google is never queried.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('openlibrary.org')
  })

  it('falls back to Google Books when Open Library has no cover', async () => {
    const fetchMock = mockFetch({
      openlibrary: { docs: [{ isbn: ['080213825X'] }] }, // no cover_i
      google: {
        items: [
          {
            volumeInfo: {
              imageLinks: { thumbnail: 'http://books.google.com/books/content?id=abc&zoom=1&edge=curl' },
              industryIdentifiers: [
                { type: 'ISBN_10', identifier: '080213825X' },
                { type: 'ISBN_13', identifier: '9780802138256' },
              ],
            },
          },
        ],
      },
    })
    const result = await resolveBookCover('Snow Crash', 'Neal Stephenson')
    expect(result?.source).toBe('google')
    // http→https and edge=curl stripped
    expect(result?.imageUrl).toBe('https://books.google.com/books/content?id=abc&zoom=1')
    expect(result?.isbn13).toBe('9780802138256')
    // OL is tried twice (strict title= then general q=) before Google Books.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns null when neither source has a cover', async () => {
    mockFetch({ openlibrary: { docs: [] }, google: { items: [] } })
    expect(await resolveBookCover('Totally Obscure', 'Nobody')).toBeNull()
  })

  it('never throws when the network fails — returns null', async () => {
    mockFetch({ throwAll: true })
    await expect(resolveBookCover('Snow Crash', 'Neal Stephenson')).resolves.toBeNull()
  })

  it('searches Open Library by the base title (subtitle stripped) and url-encodes', async () => {
    const fetchMock = mockFetch({ openlibrary: { docs: [{ cover_i: 1 }] } })
    await fromOpenLibrary('The Title: A Story', 'Jane Q. Author')
    const url = String(fetchMock.mock.calls[0][0])
    // ": A Story" subtitle is dropped so the noisy Goodreads title still matches
    expect(url).toContain('title=the%20title')
    expect(url).not.toContain('story')
    expect(url).toContain('author=Jane%20Q.%20Author')
  })

  it('strips a Goodreads series suffix from the Open Library query', async () => {
    const fetchMock = mockFetch({ openlibrary: { docs: [{ cover_i: 1 }] } })
    await fromOpenLibrary('Children of Time (Children of Time, #1)', 'Adrian Tchaikovsky')
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('title=children%20of%20time')
    expect(url).not.toContain('%23') // no "#1" series marker
  })

  it('picks the first Open Library result that actually has a cover', async () => {
    mockFetch({
      openlibrary: {
        docs: [
          { isbn: ['080213825X'] }, // top match has no cover_i
          { cover_i: 77, isbn: ['9781234567897'] },
        ],
      },
    })
    const result = await fromOpenLibrary('Some Book', 'Some Author')
    expect(result?.imageUrl).toBe('https://covers.openlibrary.org/b/id/77-L.jpg')
    expect(result?.isbn13).toBe('9781234567897')
  })

  it('strips a "[Blackstone Audio]" bracket tag from the Open Library query', async () => {
    const fetchMock = mockFetch({ openlibrary: { docs: [{ cover_i: 1 }] } })
    await fromOpenLibrary('Pride and Prejudice [Blackstone Audio]', 'Jane Austen')
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('title=pride%20and%20prejudice')
    expect(url.toLowerCase()).not.toContain('blackstone')
  })

  it('strips a ", or ..." alternative-title tail from the Open Library query', async () => {
    const fetchMock = mockFetch({ openlibrary: { docs: [{ cover_i: 1 }] } })
    await fromOpenLibrary('Blood Meridian, or the Evening Redness in the West', 'Cormac McCarthy')
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('title=blood%20meridian')
    expect(url.toLowerCase()).not.toContain('evening')
  })

  it('falls back to an Open Library general (q=) search when the strict title search misses', async () => {
    // Strict fielded title=&author= search returns no cover; the general q= search does.
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('openlibrary.org')) {
        if (url.includes('q=')) return jsonResponse({ docs: [{ cover_i: 555, isbn: ['9780000000001'] }] })
        return jsonResponse({ docs: [] }) // fielded search misses
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fn)
    const result = await fromOpenLibrary('A Christmas Carol and Other Christmas Writings', 'Charles Dickens')
    expect(result?.imageUrl).toBe('https://covers.openlibrary.org/b/id/555-L.jpg')
    expect(result?.source).toBe('openlibrary')
    // both the fielded and the fallback general search were attempted
    expect(fn).toHaveBeenCalledTimes(2)
    expect(String(fn.mock.calls[1][0])).toContain('q=')
  })

  it('fromGoogleBooks normalizes http thumbnails to https', async () => {
    mockFetch({
      google: {
        items: [{ volumeInfo: { imageLinks: { thumbnail: 'http://books.google.com/x?img=1' } } }],
      },
    })
    const result = await fromGoogleBooks('A', 'B')
    expect(result?.imageUrl).toBe('https://books.google.com/x?img=1')
    expect(result?.isbn13).toBeNull()
  })
})
