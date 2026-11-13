// /api/archive — feed archive (Completed/Skip items with kind='feed').
// Real logic lives in lib/content/queue-route.ts.

import { handleArchiveGet, type QueueRouteConfig } from '@/lib/content/queue-route'
import type { QueueItem } from '@/lib/queue-client'

const MOCK_DATA: QueueItem[] = [
  {
    id: 100,
    title: 'Completed Book Example',
    author: 'John Author',
    publishedOn: '2024-01-10T00:00:00Z',
    status: 'Completed',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2024-01-10T10:00:00Z',
    updatedAt: '2024-01-15T14:30:00Z',
    statusChangedAt: '2024-01-15T14:30:00Z',
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 100, platform: 'Audible', link: 'https://audible.com/example', messageId: null, isPrimary: true, createdAt: '2024-01-10T10:00:00Z', sourceLabel: null },
    ],
    platform: 'Audible',
    link: 'https://audible.com/example',
  },
  {
    id: 101,
    title: 'Skipped Article Example',
    author: 'Jane Writer',
    publishedOn: '2024-01-08T00:00:00Z',
    status: 'Skip',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2024-01-08T10:00:00Z',
    updatedAt: '2024-01-12T09:15:00Z',
    statusChangedAt: '2024-01-12T09:15:00Z',
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 101, platform: 'Substack', link: 'https://substack.com/example', messageId: null, isPrimary: true, createdAt: '2024-01-08T10:00:00Z', sourceLabel: null },
    ],
    platform: 'Substack',
    link: 'https://substack.com/example',
  },
]

const CONFIG: QueueRouteConfig = {
  kind: 'feed',
  revalidatePaths: ['/archive'],
  mockData: MOCK_DATA,
  logPrefix: '[Archive API]',
}

export async function GET() {
  return handleArchiveGet(CONFIG)
}
