// /api/queue — the FEED active queue (kind='feed').
// All real logic lives in lib/content/queue-route.ts; this file is just the
// per-route configuration (mock data, revalidate path, log prefix).

import {
  handleQueueGet,
  handleQueuePost,
  type QueueRouteConfig,
} from '@/lib/content/queue-route'
import type { QueueItem } from '@/lib/queue-client'

const MOCK_DATA: QueueItem[] = [
  {
    id: 1,
    title: 'The Creative Act: A Way of Being',
    author: 'Rick Rubin',
    publishedOn: '2024-01-15T00:00:00Z',
    status: 'In Progress',
    queuePosition: null,
    positionConfirmed: false,
    progress: 'Currently on chapter 3',
    addedBy: null,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
    statusChangedAt: null,
    summary:
      "A meditative exploration of creativity that draws from Rick Rubin's decades of experience producing music across genres. The book offers philosophical insights on the creative process applicable to any discipline.",
    summaryGeneratedAt: '2026-03-14T00:00:00Z',
    summaryData: {
      oneLiner: 'Creativity is a practice of noticing, not a talent reserved for artists.',
      bullets: [
        'Short meditative chapters drawn from decades producing records across genres.',
        'Argues the work should serve the audience only after it serves the maker.',
        'Best read in small doses; about 7 hours as an audiobook.',
        'For anyone in a creative rut, not just musicians.',
      ],
      sourceAccess: 'descriptions_only',
      model: 'claude-opus-5-5',
    },
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: 'https://picsum.photos/seed/creativeact/240',
    wordCount: null,
    durationSeconds: 19800,
    sources: [
      { id: 1, platform: 'Audible', link: 'https://audible.com/example', messageId: null, isPrimary: true, createdAt: '2024-01-15T10:00:00Z', sourceLabel: null },
    ],
    platform: 'Audible',
    link: 'https://audible.com/example',
  },
  {
    id: 2,
    title: 'How to Build a Second Brain',
    author: 'Tiago Forte',
    publishedOn: '2024-01-14T00:00:00Z',
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2024-01-14T10:00:00Z',
    updatedAt: '2024-01-14T10:00:00Z',
    statusChangedAt: null,
    summary: null,
    summaryGeneratedAt: null,
    summaryData: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: 'https://picsum.photos/seed/secondbrain/240',
    wordCount: 1800,
    durationSeconds: null,
    sources: [
      { id: 2, platform: 'Substack', link: 'https://substack.com/example', messageId: null, isPrimary: true, createdAt: '2024-01-14T10:00:00Z', sourceLabel: null },
    ],
    platform: 'Substack',
    link: 'https://substack.com/example',
  },
  {
    id: 3,
    title: 'Atomic Habits Podcast',
    author: 'James Clear',
    publishedOn: '2024-01-13T00:00:00Z',
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: 'spotify',
    createdAt: '2024-01-13T10:00:00Z',
    updatedAt: '2024-01-13T10:00:00Z',
    statusChangedAt: null,
    summary: null,
    summaryGeneratedAt: null,
    summaryData: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: 'https://picsum.photos/seed/atomic/240',
    wordCount: null,
    durationSeconds: 3120,
    sources: [
      { id: 3, platform: 'Spotify', link: 'https://spotify.com/example', messageId: null, isPrimary: true, createdAt: '2024-01-13T10:00:00Z', sourceLabel: null },
      { id: 30, platform: 'YouTube', link: 'https://youtube.com/example', messageId: null, isPrimary: false, createdAt: '2024-01-13T11:00:00Z', sourceLabel: null },
    ],
    platform: 'Spotify',
    link: 'https://spotify.com/example',
  },
  {
    id: 4,
    title: 'Deep Work',
    author: 'Cal Newport',
    publishedOn: '2024-01-12T00:00:00Z',
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2024-01-12T10:00:00Z',
    updatedAt: '2024-01-12T10:00:00Z',
    statusChangedAt: null,
    summary: null,
    summaryGeneratedAt: null,
    summaryData: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: 25200,
    sources: [
      { id: 4, platform: 'Audible', link: 'https://audible.com/example2', messageId: null, isPrimary: true, createdAt: '2024-01-12T10:00:00Z', sourceLabel: null },
    ],
    platform: 'Audible',
    link: 'https://audible.com/example2',
  },
  {
    id: 5,
    title: 'The Psychology of Money',
    author: 'Morgan Housel',
    publishedOn: '2024-01-11T00:00:00Z',
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2024-01-11T10:00:00Z',
    updatedAt: '2024-01-11T10:00:00Z',
    statusChangedAt: null,
    summary: null,
    summaryGeneratedAt: null,
    summaryData: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: 'https://invalid.example.invalid/broken.jpg',
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 5, platform: 'Audible', link: 'https://audible.com/example3', messageId: null, isPrimary: true, createdAt: '2024-01-11T10:00:00Z', sourceLabel: null },
    ],
    platform: 'Audible',
    link: 'https://audible.com/example3',
  },
]

const CONFIG: QueueRouteConfig = {
  kind: 'feed',
  // Revalidate the queue AND its archive (#189). A status change moves an item
  // between / and /archive: revalidating / drops the stale dynamic queue render;
  // revalidating /archive busts that route's cache too (defense-in-depth — the
  // live archive list is client-fetched on mount, so it also self-refreshes).
  // /everything (#377) lists the same active feed.
  revalidatePaths: ['/', '/archive', '/everything'],
  mockData: MOCK_DATA,
  logPrefix: '[Queue API]',
}

export async function GET() {
  return handleQueueGet(CONFIG)
}

export async function POST(request: Request) {
  return handleQueuePost(request, CONFIG)
}
