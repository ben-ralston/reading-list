// /api/books — the BOOKS active queue (kind='book'). Mirrors /api/queue
// against books-only rows via the shared handler in lib/content/queue-route.ts.

import {
  handleQueueGet,
  handleQueuePost,
  type QueueRouteConfig,
} from '@/lib/content/queue-route'
import type { QueueItem } from '@/lib/queue-client'

const MOCK_DATA: QueueItem[] = [
  {
    id: 1001,
    title: 'The Hard Thing About Hard Things',
    author: 'Ben Horowitz',
    publishedOn: '2014-03-04T00:00:00Z',
    status: 'In Progress',
    queuePosition: 1,
    positionConfirmed: true,
    progress: 'About 40% through',
    addedBy: null,
    createdAt: '2024-02-01T10:00:00Z',
    updatedAt: '2024-02-01T10:00:00Z',
    statusChangedAt: null,
    summary: null,
    summaryGeneratedAt: null,
    kind: 'book',
    sentToReaderAt: null,
    imageUrl: 'https://covers.openlibrary.org/b/id/7279515-L.jpg',
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 1001, platform: 'Audible', link: 'https://audible.com/pd/example-book', messageId: null, isPrimary: true, createdAt: '2024-02-01T10:00:00Z', sourceLabel: null },
      { id: 1002, platform: 'Physical', link: null, messageId: null, isPrimary: false, createdAt: '2024-02-01T10:05:00Z', sourceLabel: null },
    ],
    platform: 'Audible',
    link: 'https://audible.com/pd/example-book',
  },
  {
    id: 1002,
    title: 'Thinking, Fast and Slow',
    author: 'Daniel Kahneman',
    publishedOn: '2011-10-25T00:00:00Z',
    status: '',
    queuePosition: 2,
    positionConfirmed: true,
    progress: null,
    addedBy: null,
    createdAt: '2024-02-02T10:00:00Z',
    updatedAt: '2024-02-02T10:00:00Z',
    statusChangedAt: null,
    summary: null,
    summaryGeneratedAt: null,
    kind: 'book',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 1003, platform: 'Goodreads', link: 'https://www.goodreads.com/book/show/11468377', messageId: null, isPrimary: true, createdAt: '2024-02-02T10:00:00Z', sourceLabel: null },
    ],
    platform: 'Goodreads',
    link: 'https://www.goodreads.com/book/show/11468377',
  },
]

const CONFIG: QueueRouteConfig = {
  kind: 'book',
  // Revalidate the books queue AND its archive (#189). Completing/skipping moves
  // an item between /books and /books/archive: revalidating /books drops the
  // stale dynamic render; revalidating /books/archive busts that route's cache
  // too (defense-in-depth — the live archive list self-refreshes on mount).
  revalidatePaths: ['/books', '/books/archive'],
  mockData: MOCK_DATA,
  logPrefix: '[Books API]',
}

export async function GET() {
  return handleQueueGet(CONFIG)
}

export async function POST(request: Request) {
  return handleQueuePost(request, CONFIG)
}
