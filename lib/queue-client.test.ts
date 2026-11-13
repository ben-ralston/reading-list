import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchQueueData,
  fetchFeedHome,
  pinItem,
  dismissItem,
  sortByPublished,
  requestAwcConversion,
  dbToApp,
  appToDb,
  parseQueueData,
  isSortDirection,
  type QueueItem,
  type QueueItemDB,
  type QueueItemUpdate,
  type ContentItemWithSourcesDB,
} from './queue-client'

describe('Data conversion utilities', () => {
  describe('dbToApp', () => {
    it('maps a valid summary_data row to summaryData (#304)', () => {
      const dbItem: QueueItemDB = {
        id: 2, title: 'T', author: 'A', platform: 'Substack', link: 'https://example.com',
        published_on: null, status: '', queue_position: 1, position_confirmed: true, progress: null,
        message_id: null, created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z',
        summary: 'Core claim.',
        summary_data: { one_liner: 'Core claim.', bullets: ['a', 'b'], source_access: 'full_text', model: 'claude-opus-5-5', version: 2 },
      }
      expect(dbToApp(dbItem).summaryData).toEqual({
        oneLiner: 'Core claim.', bullets: ['a', 'b'], sourceAccess: 'full_text', model: 'claude-opus-5-5',
      })
    })

    it('maps missing or malformed summary_data to null (#304)', () => {
      const base: QueueItemDB = {
        id: 3, title: 'T', author: 'A', platform: 'Substack', link: 'https://example.com',
        published_on: null, status: '', queue_position: 1, position_confirmed: true, progress: null,
        message_id: null, created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z',
      }
      expect(dbToApp(base).summaryData).toBeNull()
      expect(dbToApp({ ...base, summary_data: { one_liner: 'x', version: 9 } }).summaryData).toBeNull()
    })

    it('maps the latest active awc conversion onto the item (#317)', () => {
      const base = {
        id: 4, title: 'T', author: 'A', published_on: null, status: '', queue_position: 1,
        position_confirmed: true, progress: null, created_at: '2026-10-04T00:00:00Z',
        updated_at: '2026-10-04T00:00:00Z', sources: [],
      } as unknown as ContentItemWithSourcesDB
      const item = dbToApp({ ...base, awc_conversions: [
        { id: 1, status: 'failed', error: 'x', requested_at: 'a', updated_at: 'a' },
        { id: 2, status: 'building_script', error: null, requested_at: 'b', updated_at: 'b' },
      ] })
      expect(item.awcConversion).toEqual({ kind: 'article', id: 2, status: 'building_script', error: null, requestedAt: 'b', updatedAt: 'b' })
      expect(dbToApp(base).awcConversion).toBeNull()
    })

    it('should convert legacy database record to application format with sources array', () => {
      // Legacy format (before multi-source migration)
      const dbItem: QueueItemDB = {
        id: 1,
        title: 'Test Title',
        author: 'Test Author',
        platform: 'Substack',
        link: 'https://example.com',
        published_on: '2024-01-15T00:00:00Z',
        status: 'In Progress',
        queue_position: 5,
        position_confirmed: true,
        progress: '50% complete',
        message_id: 'msg123',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T12:00:00Z',
      }

      const appItem = dbToApp(dbItem)

      // Now includes sources array and convenience fields
      expect(appItem.id).toBe(1)
      expect(appItem.title).toBe('Test Title')
      expect(appItem.author).toBe('Test Author')
      expect(appItem.platform).toBe('Substack')
      expect(appItem.link).toBe('https://example.com')
      expect(appItem.publishedOn).toBe('2024-01-15T00:00:00Z')
      expect(appItem.status).toBe('In Progress')
      expect(appItem.queuePosition).toBe(5)
      expect(appItem.positionConfirmed).toBe(true)
      expect(appItem.progress).toBe('50% complete')
      expect(appItem.createdAt).toBe('2024-01-15T10:00:00Z')
      expect(appItem.updatedAt).toBe('2024-01-15T12:00:00Z')
      // Sources array created from legacy fields
      expect(appItem.sources).toHaveLength(1)
      expect(appItem.sources[0].platform).toBe('Substack')
      expect(appItem.sources[0].link).toBe('https://example.com')
      expect(appItem.sources[0].messageId).toBe('msg123')
      expect(appItem.sources[0].isPrimary).toBe(true)
    })

    it('should convert multi-source database record correctly', () => {
      // New format with sources array
      const dbItem: ContentItemWithSourcesDB = {
        id: 1,
        title: 'Test Title',
        author: 'Test Author',
        published_on: '2024-01-15T00:00:00Z',
        status: 'In Progress',
        queue_position: 5,
        position_confirmed: true,
        progress: '50% complete',
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T12:00:00Z',
        sources: [
          {
            id: 10,
            content_item_id: 1,
            platform: 'Spotify',
            link: 'https://spotify.com/episode/123',
            message_id: 'msg123',
            is_primary: true,
            created_at: '2024-01-15T10:00:00Z',
            source_label: null,
          },
          {
            id: 11,
            content_item_id: 1,
            platform: 'YouTube',
            link: 'https://youtube.com/watch?v=abc',
            message_id: null,
            is_primary: false,
            created_at: '2024-01-15T11:00:00Z',
            source_label: null,
          },
        ],
      }

      const appItem = dbToApp(dbItem)

      expect(appItem.sources).toHaveLength(2)
      expect(appItem.platform).toBe('Spotify') // Primary source
      expect(appItem.link).toBe('https://spotify.com/episode/123')
      expect(appItem.sources[0].isPrimary).toBe(true)
      expect(appItem.sources[1].isPrimary).toBe(false)
    })

    it('maps external_id to externalId on sources (#194)', () => {
      const dbItem: ContentItemWithSourcesDB = {
        id: 1,
        title: 'Test Title',
        author: 'Test Author',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        added_by: null,
        status_changed_at: null,
        created_at: 'c',
        updated_at: 'u',
        sources: [
          {
            id: 10,
            content_item_id: 1,
            platform: 'Spotify',
            link: 'https://spotify.com/episode/123',
            message_id: null,
            is_primary: true,
            created_at: 'c',
            source_label: null,
            external_id: 'spotify:episode:abc123',
          },
          {
            id: 11,
            content_item_id: 1,
            platform: 'Substack',
            link: 'https://pub.substack.com/p/post',
            message_id: null,
            is_primary: false,
            created_at: 'c',
            source_label: null,
          },
        ],
      }

      const appItem = dbToApp(dbItem)

      expect(appItem.sources[0].externalId).toBe('spotify:episode:abc123')
      // Absent in the row (older payload shape) → null, not undefined
      expect(appItem.sources[1].externalId).toBeNull()
    })

    it('should handle null values correctly', () => {
      const dbItem: QueueItemDB = {
        id: 1,
        title: 'Test Title',
        author: 'Test Author',
        platform: 'Substack',
        link: null,
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        message_id: null,
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T12:00:00Z',
      }

      const appItem = dbToApp(dbItem)

      expect(appItem.link).toBe('')
      expect(appItem.publishedOn).toBeNull()
      expect(appItem.queuePosition).toBeNull()
      expect(appItem.positionConfirmed).toBe(false)
      expect(appItem.progress).toBeNull()
      // messageId is now inside sources array
      expect(appItem.sources[0].messageId).toBeNull()
    })

    it('maps sent_to_reader_at to sentToReaderAt for multi-source records (#171)', () => {
      const dbItem: ContentItemWithSourcesDB = {
        id: 1,
        title: 'T',
        author: 'A',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        created_at: 'c',
        updated_at: 'u',
        sent_to_reader_at: '2026-06-06T00:00:00Z',
        sources: [
          {
            id: 1,
            content_item_id: 1,
            platform: 'Substack',
            link: 'https://example.com',
            message_id: null,
            is_primary: true,
            created_at: 'c',
            source_label: null,
          },
        ],
      }

      expect(dbToApp(dbItem).sentToReaderAt).toBe('2026-06-06T00:00:00Z')
    })

    it('defaults sentToReaderAt to null when the column is absent (#171)', () => {
      const dbItem: QueueItemDB = {
        id: 1,
        title: 'T',
        author: 'A',
        platform: 'Substack',
        link: 'https://example.com',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        message_id: null,
        created_at: 'c',
        updated_at: 'u',
      }

      expect(dbToApp(dbItem).sentToReaderAt).toBeNull()
    })
  })

  describe('appToDb', () => {
    it('should convert application object to database format', () => {
      const appItem: Partial<QueueItem> = {
        id: 1,
        title: 'Test Title',
        status: 'Completed',
      }

      const dbItem = appToDb(appItem)

      expect(dbItem).toEqual({
        id: 1,
        title: 'Test Title',
        status: 'Completed',
      })
    })

    it('should handle partial updates', () => {
      const appItem: Partial<QueueItem> = {
        id: 1,
        status: 'In Progress',
      }

      const dbItem = appToDb(appItem)

      expect(dbItem).toEqual({
        id: 1,
        status: 'In Progress',
      })
    })

    it('should ignore link field (now in content_sources table)', () => {
      // link is now stored in content_sources, not content_items
      // appToDb only handles content_items fields
      const appItem: Partial<QueueItem> = {
        id: 1,
        link: 'https://example.com',
      }

      const dbItem = appToDb(appItem)

      // link should not be in the result
      expect(dbItem).toEqual({ id: 1 })
      expect('link' in dbItem).toBe(false)
    })

    it('should convert positionConfirmed field correctly', () => {
      const appItem: Partial<QueueItem> = {
        id: 1,
        queuePosition: 5,
        positionConfirmed: true,
      }

      const dbItem = appToDb(appItem)

      expect(dbItem).toEqual({
        id: 1,
        queue_position: 5,
        position_confirmed: true,
      })
    })

    it('never emits kind on update payloads (kind is INSERT-only via the RPC)', () => {
      const appItem: Partial<QueueItem> = {
        id: 1,
        status: 'In Progress',
        kind: 'book',
      }

      const dbItem = appToDb(appItem) as Record<string, unknown>

      expect('kind' in dbItem).toBe(false)
      expect(dbItem).toEqual({ id: 1, status: 'In Progress' })
    })

    it('never emits engagementScore (derived server-side, #255)', () => {
      const appItem: Partial<QueueItem> = {
        id: 1,
        status: 'In Progress',
        engagementScore: 0.5,
      }

      const dbItem = appToDb(appItem) as Record<string, unknown>

      expect('engagementScore' in dbItem).toBe(false)
      expect('engagement_score' in dbItem).toBe(false)
      expect(dbItem).toEqual({ id: 1, status: 'In Progress' })
    })
  })

  describe('feed-card enrichment fields (#167)', () => {
    it('maps image_url / word_count / duration_seconds on multi-source rows', () => {
      const dbItem: ContentItemWithSourcesDB = {
        id: 1,
        title: 'Enriched',
        author: 'Author',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T12:00:00Z',
        image_url: 'https://cdn.example.com/thumb.jpg',
        word_count: 1200,
        duration_seconds: 2400,
        sources: [],
      }

      const appItem = dbToApp(dbItem)

      expect(appItem.imageUrl).toBe('https://cdn.example.com/thumb.jpg')
      expect(appItem.wordCount).toBe(1200)
      expect(appItem.durationSeconds).toBe(2400)
    })

    it('defaults missing enrichment fields to null (multi-source)', () => {
      const dbItem: ContentItemWithSourcesDB = {
        id: 2,
        title: 'Bare',
        author: 'Author',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T12:00:00Z',
        sources: [],
      }

      const appItem = dbToApp(dbItem)

      expect(appItem.imageUrl).toBeNull()
      expect(appItem.wordCount).toBeNull()
      expect(appItem.durationSeconds).toBeNull()
    })

    it('maps enrichment fields on legacy rows and defaults missing to null', () => {
      const dbItem: QueueItemDB = {
        id: 3,
        title: 'Legacy',
        author: 'Author',
        platform: 'Substack',
        link: 'https://example.com',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        message_id: null,
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T12:00:00Z',
        image_url: 'https://cdn.example.com/legacy.jpg',
      }

      const appItem = dbToApp(dbItem)

      expect(appItem.imageUrl).toBe('https://cdn.example.com/legacy.jpg')
      expect(appItem.wordCount).toBeNull()
      expect(appItem.durationSeconds).toBeNull()
    })

    it('never emits enrichment fields on update payloads (INSERT-only via the RPC)', () => {
      const appItem: Partial<QueueItem> = {
        id: 1,
        status: 'In Progress',
        imageUrl: 'https://cdn.example.com/x.jpg',
        wordCount: 999,
        durationSeconds: 60,
      }

      const dbItem = appToDb(appItem) as Record<string, unknown>

      expect('image_url' in dbItem).toBe(false)
      expect('word_count' in dbItem).toBe(false)
      expect('duration_seconds' in dbItem).toBe(false)
      expect(dbItem).toEqual({ id: 1, status: 'In Progress' })
    })
  })

  describe('per-source progress mapping (#194)', () => {
    it('maps content_sources.progress and defaults missing to null', () => {
      const dbItem: ContentItemWithSourcesDB = {
        id: 1,
        title: 'T',
        author: 'A',
        published_on: null,
        status: 'In Progress',
        queue_position: 1,
        position_confirmed: true,
        progress: '45',
        added_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status_changed_at: null,
        sources: [
          {
            id: 10,
            content_item_id: 1,
            platform: 'Substack',
            link: 'https://pub.substack.com/p/x',
            message_id: null,
            is_primary: true,
            created_at: '2026-01-01T00:00:00Z',
            source_label: null,
            progress: 42,
          },
          {
            id: 11,
            content_item_id: 1,
            platform: 'Spotify',
            link: 'https://open.spotify.com/episode/abc',
            message_id: null,
            is_primary: false,
            created_at: '2026-01-01T00:00:00Z',
            source_label: null,
            external_id: 'spotify:episode:abc',
            // no progress key — legacy payload shape
          },
        ],
      }

      const item = dbToApp(dbItem)

      expect(item.sources[0].progress).toBe(42)
      expect(item.sources[1].progress).toBeNull()
    })
  })

  describe('kind discriminator (#147)', () => {
    it('defaults missing DB kind to "feed" on multi-source rows', () => {
      const dbItem: ContentItemWithSourcesDB = {
        id: 7,
        title: 'Old Row',
        author: 'Someone',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        added_by: null,
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        status_changed_at: null,
        sources: [],
        // kind intentionally omitted — simulates a row from before the migration
      }

      expect(dbToApp(dbItem).kind).toBe('feed')
    })

    it('preserves kind="book" on multi-source rows', () => {
      const dbItem: ContentItemWithSourcesDB = {
        id: 8,
        title: 'A Book',
        author: 'Someone',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        added_by: null,
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        status_changed_at: null,
        kind: 'book',
        sources: [
          {
            id: 1,
            content_item_id: 8,
            platform: 'Goodreads',
            link: 'https://www.goodreads.com/book/show/123',
            message_id: null,
            is_primary: true,
            created_at: '2024-01-15T10:00:00Z',
            source_label: null,
          },
        ],
      }

      const app = dbToApp(dbItem)
      expect(app.kind).toBe('book')
      expect(app.platform).toBe('Goodreads')
    })

    it('preserves a Physical source with link=null through dbToApp', () => {
      const dbItem: ContentItemWithSourcesDB = {
        id: 9,
        title: 'Some Book',
        author: 'Someone',
        published_on: null,
        status: '',
        queue_position: null,
        position_confirmed: false,
        progress: null,
        added_by: null,
        created_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:00:00Z',
        status_changed_at: null,
        kind: 'book',
        sources: [
          {
            id: 2,
            content_item_id: 9,
            platform: 'Physical',
            link: null,
            message_id: null,
            is_primary: true,
            created_at: '2024-01-15T10:00:00Z',
            source_label: null,
          },
        ],
      }

      const app = dbToApp(dbItem)
      expect(app.sources[0].link).toBeNull()
      // Convenience field falls back to '' so legacy callers that expect a string don't break.
      expect(app.link).toBe('')
    })
  })
})

// Helper to create a minimal QueueItem for testing
function createTestItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    title: 'Test',
    author: 'Author',
    platform: 'Web',
    link: '',
    publishedOn: null,
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2024-01-01T10:00:00Z',
    updatedAt: '2024-01-01T10:00:00Z',
    statusChangedAt: null,
    kind: 'feed',
    sources: [],
    ...overrides,
  }
}

describe('parseQueueData', () => {
  it('should handle empty data', () => {
    const items: QueueItem[] = []
    const result = parseQueueData(items)
    expect(result).toEqual([])
  })

  it('should sort items with queue_position first', () => {
    const items: QueueItem[] = [
      createTestItem({
        id: 1,
        title: 'Book 1',
        queuePosition: null,
        publishedOn: '2024-01-01T00:00:00Z',
      }),
      createTestItem({
        id: 2,
        title: 'Book 2',
        queuePosition: 1,
        positionConfirmed: true,
        publishedOn: '2024-01-02T00:00:00Z',
      }),
    ]

    const result = parseQueueData(items)

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('Book 2') // Has queue_position
    expect(result[1].title).toBe('Book 1') // No queue_position
  })

  it('should sort by queue_position value (lower first)', () => {
    const items: QueueItem[] = [
      createTestItem({
        id: 1,
        title: 'Book 1',
        queuePosition: 3,
        publishedOn: '2024-01-01T00:00:00Z',
      }),
      createTestItem({
        id: 2,
        title: 'Book 2',
        queuePosition: 1,
        publishedOn: '2024-01-02T00:00:00Z',
      }),
    ]

    const result = parseQueueData(items)

    expect(result).toHaveLength(2)
    expect(result[0].queuePosition).toBe(1)
    expect(result[1].queuePosition).toBe(3)
  })

  it('should sort In Progress items first (for items without queue_position)', () => {
    const items: QueueItem[] = [
      createTestItem({
        id: 1,
        title: 'Book 1',
        status: '',
        publishedOn: '2024-01-01T00:00:00Z',
      }),
      createTestItem({
        id: 2,
        title: 'Book 2',
        status: 'In Progress',
        publishedOn: '2024-01-02T00:00:00Z',
      }),
    ]

    const result = parseQueueData(items)

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('Book 2')
    expect(result[0].status).toBe('In Progress')
  })

  it('keeps unpositioned Awaiting comments items in the started priority group', () => {
    const result = parseQueueData([
      createTestItem({ id: 1, status: '', publishedOn: '2026-09-01' }),
      createTestItem({ id: 2, status: 'Awaiting comments', publishedOn: '2026-01-01' }),
      createTestItem({ id: 3, status: 'In Progress', publishedOn: '2025-01-01' }),
    ])
    expect(result.map(item => item.id)).toEqual([2, 3, 1])
  })

  it('should sort by date (newest first) for items without queue position or In Progress status', () => {
    const items: QueueItem[] = [
      createTestItem({
        id: 1,
        title: 'Book 1',
        publishedOn: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T10:00:00Z',
      }),
      createTestItem({
        id: 2,
        title: 'Book 2',
        publishedOn: '2024-01-03T00:00:00Z',
        createdAt: '2024-01-03T10:00:00Z',
      }),
      createTestItem({
        id: 3,
        title: 'Book 3',
        publishedOn: '2024-01-02T00:00:00Z',
        createdAt: '2024-01-02T10:00:00Z',
      }),
    ]

    const result = parseQueueData(items)

    expect(result).toHaveLength(3)
    expect(result[0].publishedOn).toBe('2024-01-03T00:00:00Z') // Newest
    expect(result[1].publishedOn).toBe('2024-01-02T00:00:00Z')
    expect(result[2].publishedOn).toBe('2024-01-01T00:00:00Z') // Oldest
  })

  it('should use createdAt when publishedOn is null', () => {
    const items: QueueItem[] = [
      createTestItem({
        id: 1,
        title: 'Book 1',
        publishedOn: null,
        createdAt: '2024-01-01T10:00:00Z',
      }),
      createTestItem({
        id: 2,
        title: 'Book 2',
        publishedOn: null,
        createdAt: '2024-01-03T10:00:00Z',
      }),
    ]

    const result = parseQueueData(items)

    expect(result).toHaveLength(2)
    expect(result[0].createdAt).toBe('2024-01-03T10:00:00Z') // Newest
    expect(result[1].createdAt).toBe('2024-01-01T10:00:00Z') // Oldest
  })

  describe('duplicate position-1 items in date sort (#229)', () => {
    it('newest sort keeps ALL items when several share queuePosition 1', () => {
      const items: QueueItem[] = [
        createTestItem({ id: 1, queuePosition: 1, positionConfirmed: true, publishedOn: '2026-07-07T00:00:00Z' }),
        createTestItem({ id: 2, queuePosition: 1, positionConfirmed: true, publishedOn: '2026-07-16T00:00:00Z' }),
        createTestItem({ id: 3, queuePosition: 2, positionConfirmed: true, publishedOn: '2026-07-10T00:00:00Z' }),
        createTestItem({ id: 4, queuePosition: null, publishedOn: '2026-07-17T00:00:00Z' }),
      ]

      const result = parseQueueData(items, 'newest')

      expect(result).toHaveLength(4) // nothing dropped
      expect(result.map(i => i.id).sort()).toEqual([1, 2, 3, 4])
      expect(result[0].queuePosition).toBe(1) // one pos-1 item pinned on top
      // the OTHER pos-1 item is still present, date-sorted among the rest
      expect(result.slice(1).some(i => i.queuePosition === 1)).toBe(true)
    })

    it('oldest sort keeps ALL items when several share queuePosition 1', () => {
      const items: QueueItem[] = [
        createTestItem({ id: 1, queuePosition: 1, positionConfirmed: true, publishedOn: '2026-07-07T00:00:00Z' }),
        createTestItem({ id: 2, queuePosition: 1, positionConfirmed: true, publishedOn: '2026-07-16T00:00:00Z' }),
        createTestItem({ id: 3, queuePosition: 2, positionConfirmed: true, publishedOn: '2026-07-10T00:00:00Z' }),
      ]

      const result = parseQueueData(items, 'oldest')

      expect(result).toHaveLength(3)
      expect(result[0].queuePosition).toBe(1)
      const otherPosOne = items.find(i => i.queuePosition === 1 && i.id !== result[0].id)!
      expect(result.slice(1).map(i => i.id)).toContain(otherPosOne.id)
    })
  })

  describe('recommended sort (#255)', () => {
    // The position-1 item stays the hero here, exactly as in newest/oldest, so
    // "Make it next" has a visible effect in this mode too. Scoring orders
    // everything below it.
    it('pins the position-1 item at top even when another item outscores it', () => {
      const items: QueueItem[] = [
        createTestItem({
          id: 1, queuePosition: 1, positionConfirmed: true,
          publishedOn: '2024-01-01T00:00:00Z',
        }),
        createTestItem({
          id: 2, status: 'In Progress', progress: '50',
          publishedOn: '2026-07-30T00:00:00Z',
        }),
        createTestItem({ id: 3, publishedOn: '2026-07-31T00:00:00Z' }),
      ]

      const result = parseQueueData(items, 'recommended')

      expect(result).toHaveLength(3)
      expect(result[0].id).toBe(1) // pinned hero
      expect(result[1].id).toBe(2) // highest-scoring of the rest (in progress)
    })

    it('scores normally when nothing holds position 1', () => {
      const items: QueueItem[] = [
        createTestItem({ id: 1, publishedOn: '2024-01-01T00:00:00Z' }),
        createTestItem({ id: 2, status: 'In Progress', progress: '50' }),
      ]

      const result = parseQueueData(items, 'recommended')

      expect(result[0].id).toBe(2)
    })

    it('keeps ALL items when several share queuePosition 1 (#229)', () => {
      const items: QueueItem[] = [
        createTestItem({ id: 1, queuePosition: 1, positionConfirmed: true, publishedOn: '2026-07-07T00:00:00Z' }),
        createTestItem({ id: 2, queuePosition: 1, positionConfirmed: true, publishedOn: '2026-07-16T00:00:00Z' }),
        createTestItem({ id: 3, queuePosition: 2, positionConfirmed: true, publishedOn: '2026-07-10T00:00:00Z' }),
      ]

      const result = parseQueueData(items, 'recommended')

      expect(result).toHaveLength(3)
      expect(result[0].queuePosition).toBe(1)
      // The other position-1 row is still present, scored among the rest.
      expect(result.slice(1).some(i => i.queuePosition === 1)).toBe(true)
    })

    it('does not mutate the caller array', () => {
      const items: QueueItem[] = [
        createTestItem({ id: 1, publishedOn: '2024-01-01T00:00:00Z' }),
        createTestItem({ id: 2, status: 'In Progress' }),
      ]

      parseQueueData(items, 'recommended')

      expect(items.map(i => i.id)).toEqual([1, 2])
    })
  })
})

describe('isSortDirection', () => {
  it('accepts all four sort modes', () => {
    expect(isSortDirection('queue')).toBe(true)
    expect(isSortDirection('newest')).toBe(true)
    expect(isSortDirection('oldest')).toBe(true)
    expect(isSortDirection('recommended')).toBe(true)
  })

  it('rejects garbage and null', () => {
    expect(isSortDirection('garbage')).toBe(false)
    expect(isSortDirection('')).toBe(false)
    expect(isSortDirection(null)).toBe(false)
  })
})

describe('QueueItemUpdate interface', () => {
  it('should accept partial updates with only id and status', () => {
    const update: QueueItemUpdate = {
      id: 1,
      status: 'In Progress',
    }

    expect(update.id).toBe(1)
    expect(update.status).toBe('In Progress')
    expect(update.queuePosition).toBeUndefined()
    expect(update.positionConfirmed).toBeUndefined()
  })

  it('should accept partial updates with only id and queuePosition', () => {
    const update: QueueItemUpdate = {
      id: 2,
      queuePosition: 5,
    }

    expect(update.id).toBe(2)
    expect(update.queuePosition).toBe(5)
    expect(update.status).toBeUndefined()
    expect(update.positionConfirmed).toBeUndefined()
  })

  it('should accept all fields for batch update', () => {
    const update: QueueItemUpdate = {
      id: 3,
      status: 'In Progress',
      queuePosition: 1,
      positionConfirmed: true,
    }

    expect(update.id).toBe(3)
    expect(update.status).toBe('In Progress')
    expect(update.queuePosition).toBe(1)
    expect(update.positionConfirmed).toBe(true)
  })

  it('should allow queuePosition to be null', () => {
    const update: QueueItemUpdate = {
      id: 4,
      queuePosition: null,
    }

    expect(update.id).toBe(4)
    expect(update.queuePosition).toBeNull()
  })

  it('should support array of updates for batch operations', () => {
    const updates: QueueItemUpdate[] = [
      { id: 1, status: '' },
      { id: 2, queuePosition: 2 },
      { id: 3, queuePosition: 3 },
      { id: 5, queuePosition: 1, positionConfirmed: true, status: 'In Progress' },
    ]

    expect(updates).toHaveLength(4)
    expect(updates[0].id).toBe(1)
    expect(updates[3].status).toBe('In Progress')
  })
})

describe('requestAwcConversion (#317)', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('returns the created conversion', async () => {
    const conv = { id: 9, status: 'queued', error: null, requestedAt: 'r', updatedAt: 'u' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(conv), { status: 200 })))
    expect(await requestAwcConversion(5)).toEqual({ conversion: conv, alreadyActive: false })
  })
  it('returns the existing conversion on 409 (already converting on another device)', async () => {
    const conv = { id: 7, status: 'starting', error: null, requestedAt: 'r', updatedAt: 'u' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Already converting', conversion: conv }), { status: 409 })))
    expect(await requestAwcConversion(5)).toEqual({ conversion: conv, alreadyActive: true })
  })
  it('returns a null conversion on a 409 without one (it finished in between)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Already converting', conversion: null }), { status: 409 })))
    expect(await requestAwcConversion(5)).toEqual({ conversion: null, alreadyActive: true })
  })
  it('throws on other errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 422 })))
    await expect(requestAwcConversion(5)).rejects.toThrow()
  })
})

describe('shortlist state mapping (#377)', () => {
  const base: ContentItemWithSourcesDB = {
    id: 9,
    title: 'Pinned Row',
    author: 'Someone',
    published_on: null,
    status: '',
    queue_position: null,
    position_confirmed: false,
    progress: null,
    added_by: null,
    created_at: '2026-11-09T10:00:00Z',
    updated_at: '2026-11-09T10:00:00Z',
    status_changed_at: null,
    sources: [],
  }

  it('maps pinned_at and shortlist_dismissed_at', () => {
    const app = dbToApp({ ...base, pinned_at: '2026-11-09T11:00:00Z', shortlist_dismissed_at: '2026-11-08T11:00:00Z' })
    expect(app.pinnedAt).toBe('2026-11-09T11:00:00Z')
    expect(app.shortlistDismissedAt).toBe('2026-11-08T11:00:00Z')
  })

  it('defaults both to null when the columns are absent', () => {
    const app = dbToApp(base)
    expect(app.pinnedAt).toBeNull()
    expect(app.shortlistDismissedAt).toBeNull()
  })
})

describe('feed home client calls (#377)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetchFeedHome returns items and curation from /api/queue', async () => {
    const body = { items: [{ id: 1, title: 'T' }], curation: { finishedAt: 'f', picks: [{ id: 1, reason: null }] } }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchFeedHome()).toEqual(body)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/queue')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' })
  })

  it('fetchFeedHome tolerates the old array response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 1 }]), { status: 200 })))
    expect(await fetchFeedHome()).toEqual({ items: [{ id: 1 }], curation: null })
  })

  it('pinItem and dismissItem post their actions', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    await pinItem(3)
    await dismissItem(4)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'pin', id: 3 })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: 'dismiss', id: 4 })
  })

  it('pinItem surfaces the server error message (e.g. 409)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Item is no longer in the queue' }), { status: 409 })))
    await expect(pinItem(3)).rejects.toThrow('Item is no longer in the queue')
  })
})

describe('sortByPublished (#377)', () => {
  const at = (id: number, publishedOn: string | null, createdAt: string, queuePosition: number | null = null) =>
    ({ ...dbToApp({
      id, title: `T${id}`, author: 'A', published_on: publishedOn, status: '', queue_position: queuePosition,
      position_confirmed: queuePosition !== null, progress: null, added_by: null, created_at: createdAt,
      updated_at: createdAt, status_changed_at: null, sources: [],
    }) })
  const items = [
    at(1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 1),
    at(2, null, '2026-11-05T00:00:00Z'),
    at(3, '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z'),
    at(4, '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z'),
  ]

  it('newest first, ignoring a legacy position 1, ties by higher id', () => {
    expect(sortByPublished(items, 'newest').map(i => i.id)).toEqual([2, 4, 3, 1])
  })

  it('oldest first', () => {
    expect(sortByPublished(items, 'oldest').map(i => i.id)).toEqual([1, 4, 3, 2])
  })

  it('returns a new array', () => {
    const copy = [...items]
    sortByPublished(items, 'newest')
    expect(items).toEqual(copy)
  })
})

describe('fetchQueueData on the feed envelope (#377)', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('unwraps { items } instead of crashing', async () => {
    const row = dbToApp({
      id: 1, title: 'T', author: 'A', published_on: null, status: '', queue_position: null, position_confirmed: false,
      progress: null, added_by: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
      status_changed_at: null, sources: [],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [row], curation: null }), { status: 200 })))
    expect((await fetchQueueData()).map(i => i.id)).toEqual([1])
  })
})
