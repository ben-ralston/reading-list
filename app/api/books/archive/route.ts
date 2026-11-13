// /api/books/archive — books archive (Completed/Skip items with kind='book').
// Mirrors /api/archive against books-only rows.

import { handleArchiveGet, type QueueRouteConfig } from '@/lib/content/queue-route'
import type { QueueItem } from '@/lib/queue-client'

const MOCK_DATA: QueueItem[] = [
  {
    id: 2001,
    title: 'Sapiens: A Brief History of Humankind',
    author: 'Yuval Noah Harari',
    publishedOn: '2014-02-10T00:00:00Z',
    status: 'Completed',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2023-12-01T10:00:00Z',
    updatedAt: '2024-01-10T14:30:00Z',
    statusChangedAt: '2024-01-10T14:30:00Z',
    kind: 'book',
    sentToReaderAt: null,
    imageUrl: 'https://covers.openlibrary.org/b/id/8634250-L.jpg',
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 2001, platform: 'Goodreads', link: 'https://www.goodreads.com/book/show/23692271', messageId: null, isPrimary: true, createdAt: '2023-12-01T10:00:00Z', sourceLabel: null },
    ],
    platform: 'Goodreads',
    link: 'https://www.goodreads.com/book/show/23692271',
  },
]

const CONFIG: QueueRouteConfig = {
  kind: 'book',
  revalidatePaths: ['/books/archive'],
  mockData: MOCK_DATA,
  logPrefix: '[Books Archive API]',
}

export async function GET() {
  return handleArchiveGet(CONFIG)
}
