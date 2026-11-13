import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ArchiveList } from './archive-list'
import type { QueueItem } from '@/lib/queue-client'

// Minimal archived-item factory — archive cards read status + sources + dates.
function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    title: 'Archived Item',
    author: 'Some Author',
    publishedOn: '2021-01-01T00:00:00Z',
    status: 'Completed',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    statusChangedAt: '2026-01-02T00:00:00Z',
    kind: 'book',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 1, platform: 'Goodreads', link: 'https://www.goodreads.com/book/show/1', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
    ],
    platform: 'Goodreads',
    link: 'https://www.goodreads.com/book/show/1',
    ...overrides,
  }
}

const noop = async () => {}

describe('ArchiveList book covers (#168)', () => {
  it('shows the cover image for an archived book with imageUrl', () => {
    const { container } = render(
      <ArchiveList
        items={[makeItem({ imageUrl: 'https://covers.openlibrary.org/b/id/9-L.jpg' })]}
        onRestore={noop}
        kind="book"
      />,
    )
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://covers.openlibrary.org/b/id/9-L.jpg')
  })

  it('shows a book-cover placeholder when an archived book has no cover', () => {
    const { container } = render(
      <ArchiveList items={[makeItem({ imageUrl: null })]} onRestore={noop} kind="book" />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[aria-label="Book cover placeholder"]')).toBeTruthy()
  })

  it('shows the preview image for archived feed items, as in the queue (#303)', () => {
    const { container } = render(
      <ArchiveList
        items={[makeItem({ kind: 'feed', imageUrl: 'https://cdn.example.com/og.jpg' })]}
        onRestore={noop}
        kind="feed"
      />,
    )
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/og.jpg')
    expect(img!.closest('.float-right')).toBeTruthy()
    expect(container.querySelector('[aria-label="Book cover placeholder"]')).toBeNull()
  })
})

describe('ArchiveList search (#283)', () => {
  const items = () => [
    makeItem({ id: 1, title: 'The Bitter Lesson', author: 'Rich Sutton' }),
    makeItem({ id: 2, title: 'Attention Is All You Need', author: 'Vaswani' }),
    makeItem({ id: 3, title: 'Lesson Planning', author: 'Jane Doe' }),
  ]

  it('renders a search field and filters cards by title or author', () => {
    const { getByRole, queryByText, getByText } = render(
      <ArchiveList items={items()} onRestore={noop} kind="feed" />,
    )
    fireEvent.change(getByRole('searchbox', { name: 'Search by title or author' }), {
      target: { value: 'lesson' },
    })
    expect(getByText('The Bitter Lesson')).toBeTruthy()
    expect(getByText('Lesson Planning')).toBeTruthy()
    expect(queryByText('Attention Is All You Need')).toBeNull()
    expect(getByText('2 of 3 completed or skipped items')).toBeTruthy()
  })

  it('shows the plain count line when no search is active', () => {
    const { getByText } = render(<ArchiveList items={items()} onRestore={noop} kind="feed" />)
    expect(getByText('3 completed or skipped items')).toBeTruthy()
  })

  it('shows a search-specific empty state and clears back to the full list', () => {
    const { getByRole, getByText, queryByText } = render(
      <ArchiveList items={items()} onRestore={noop} kind="feed" />,
    )
    fireEvent.change(getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(getByText('No items match "zzz"')).toBeTruthy()
    expect(queryByText('No archived items')).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Clear search' }))
    expect(getByText('The Bitter Lesson')).toBeTruthy()
  })

  it('uses a kind-specific placeholder', () => {
    const feed = render(<ArchiveList items={[]} onRestore={noop} kind="feed" />)
    expect((feed.getByRole('searchbox') as HTMLInputElement).placeholder).toBe('Search archive')
    feed.unmount()
    const books = render(<ArchiveList items={[]} onRestore={noop} kind="book" />)
    expect((books.getByRole('searchbox') as HTMLInputElement).placeholder).toBe('Search books archive')
  })
})

describe('ArchiveList desktop layout (#303)', () => {
  it('keeps the mobile width and widens to 3xl at lg', () => {
    const { container } = render(<ArchiveList items={[makeItem()]} onRestore={noop} kind="book" />)
    const root = container.firstElementChild as HTMLElement
    expect(root.classList.contains('max-w-md')).toBe(true)
    expect(root.classList.contains('lg:max-w-3xl')).toBe(true)
  })

  // Same two-row grid as the queue cards: text beside the cover on top, meta
  // chips on the bottom row with Restore at its right end.
  it('lays a book archive card out as a two-row grid at lg', () => {
    const { getByRole, getByText } = render(
      <ArchiveList items={[makeItem({ title: 'Old Book' })]} onRestore={noop} kind="book" />,
    )
    const restore = getByRole('button', { name: /Restore to Queue/ })
    expect(restore.classList.contains('w-full')).toBe(true)
    for (const c of ['lg:w-auto', 'lg:row-start-2', 'lg:col-start-3']) {
      expect(restore.classList.contains(c)).toBe(true)
    }
    const card = restore.parentElement as HTMLElement
    for (const c of ['lg:grid', 'lg:grid-cols-[auto_minmax(0,1fr)_auto]']) {
      expect(card.classList.contains(c)).toBe(true)
    }
    const cover = card.firstElementChild as HTMLElement
    expect(cover.classList.contains('float-right')).toBe(true)
    expect(cover.classList.contains('lg:col-start-1')).toBe(true)
    const textCol = getByText('Old Book').closest('.lg\\:col-span-2') as HTMLElement
    expect(textCol.parentElement).toBe(card)
    expect(textCol.classList.contains('lg:row-start-1')).toBe(true)
    const meta = restore.previousElementSibling as HTMLElement
    for (const c of ['lg:row-start-2', 'lg:col-start-1', 'lg:col-span-2', 'lg:justify-start']) {
      expect(meta.classList.contains(c)).toBe(true)
    }
  })

  it('gives feed archive cards the same thumbnail grid at lg', () => {
    const { getByRole, getByText } = render(
      <ArchiveList items={[makeItem({ kind: 'feed', title: 'Old Post' })]} onRestore={noop} kind="feed" />,
    )
    const restore = getByRole('button', { name: /Restore to Queue/ })
    const card = restore.parentElement as HTMLElement
    expect(card.classList.contains('lg:grid-cols-[auto_minmax(0,1fr)_auto]')).toBe(true)
    expect(restore.classList.contains('lg:col-start-3')).toBe(true)
    const thumb = card.firstElementChild as HTMLElement
    expect(thumb.classList.contains('lg:col-start-1')).toBe(true)
    const textCol = getByText('Old Post').closest('.lg\\:col-span-2') as HTMLElement
    expect(textCol.parentElement).toBe(card)
    expect((restore.previousElementSibling as HTMLElement).classList.contains('lg:col-span-2')).toBe(true)
  })
})
