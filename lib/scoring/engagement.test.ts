import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractSeriesKey, getSeriesScore, getAuthorScore, getEngagementScore } from './engagement'

// ---------------------------------------------------------------------------
// extractSeriesKey
// ---------------------------------------------------------------------------

describe('extractSeriesKey', () => {
  it('extracts series key from "AI #140: Trying To Hold The Line"', () => {
    expect(extractSeriesKey('AI #140: Trying To Hold The Line')).toBe('AI #')
  })

  it('extracts series key from "Open Thread 402"', () => {
    expect(extractSeriesKey('Open Thread 402')).toBe('Open Thread')
  })

  it('extracts series key from "Monthly Roundup #35: October"', () => {
    expect(extractSeriesKey('Monthly Roundup #35: October 2025')).toBe('Monthly Roundup #')
  })

  it('returns first-2-words for standalone titles without number pattern', () => {
    // No colon, no trailing digits — falls back to first 2 words.
    // Won't match a real series (< 3 items), so getEngagementScore falls back to author score.
    expect(extractSeriesKey("The Claude Constitution's Ethical Framework")).toBe('The Claude')
  })

  it('handles "Links For December 2025" by stripping trailing year', () => {
    expect(extractSeriesKey('Links For December 2025')).toBe('Links For December')
  })

  it('returns null for empty/null input', () => {
    expect(extractSeriesKey('')).toBeNull()
    expect(extractSeriesKey(null as unknown as string)).toBeNull()
    expect(extractSeriesKey(undefined as unknown as string)).toBeNull()
  })

  it('returns null for short titles without pattern', () => {
    expect(extractSeriesKey('Hi')).toBeNull()
  })

  it('handles title with only numbers after colon prefix', () => {
    expect(extractSeriesKey('AI #155: Another Episode')).toBe('AI #')
  })

  it('handles multiple colons — only splits on first', () => {
    expect(extractSeriesKey('AI #100: Part 1: Details')).toBe('AI #')
  })
})

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

function createMockSupabase(options: {
  aliases?: string[]
  authorItems?: Array<{ title: string; status: string; author: string }>
  engagementScores?: Array<{ engagement_score: number; aliases: string[] }>
}) {
  const { aliases = [], authorItems = [], engagementScores = [] } = options

  return {
    rpc: vi.fn().mockImplementation((funcName: string) => {
      if (funcName === 'get_author_aliases') {
        return { data: aliases, error: null }
      }
      return { data: null, error: null }
    }),
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'content_items') {
        return {
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({ data: authorItems, error: null }),
          }),
        }
      }
      if (table === 'author_engagement_scores') {
        return {
          select: vi.fn().mockResolvedValue({ data: engagementScores, error: null }),
        }
      }
      return {
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
      }
    }),
  } as any
}

// ---------------------------------------------------------------------------
// getSeriesScore
// ---------------------------------------------------------------------------

describe('getSeriesScore', () => {
  it('returns series score when enough data exists', async () => {
    const supabase = createMockSupabase({
      aliases: ['zvi mowshowitz', "don't worry about the vase"],
      authorItems: [
        // 17 "AI #" items: 16 completed, 1 skipped (score ≈ 0.88)
        ...Array.from({ length: 16 }, (_, i) => ({
          title: `AI #${140 + i}: Episode ${i}`,
          status: 'Completed',
          author: 'Zvi Mowshowitz',
        })),
        { title: 'AI #156: Skipped One', status: 'Skip', author: 'Zvi Mowshowitz' },
      ],
    })

    const score = await getSeriesScore('AI #', 'Zvi Mowshowitz', supabase)
    expect(score).not.toBeNull()
    // (16 - 1) / 17 ≈ 0.882
    expect(score).toBeCloseTo(15 / 17, 2)
  })

  it('returns null when series has < 3 items', async () => {
    const supabase = createMockSupabase({
      aliases: ['scott alexander', 'astral codex ten'],
      authorItems: [
        { title: 'Links For November', status: 'Skip', author: 'Scott Alexander' },
        { title: 'Links For December', status: 'Completed', author: 'Scott Alexander' },
      ],
    })

    const score = await getSeriesScore('Links For', 'Scott Alexander', supabase)
    expect(score).toBeNull()
  })

  it('returns null when < 2 decided items', async () => {
    const supabase = createMockSupabase({
      aliases: ['scott alexander'],
      authorItems: [
        { title: 'Links For November', status: '', author: 'Scott Alexander' },
        { title: 'Links For December', status: '', author: 'Scott Alexander' },
        { title: 'Links For January', status: 'Completed', author: 'Scott Alexander' },
      ],
    })

    const score = await getSeriesScore('Links For', 'Scott Alexander', supabase)
    expect(score).toBeNull()
  })

  it('returns -1.0 for consistently skipped series', async () => {
    const supabase = createMockSupabase({
      aliases: ['scott alexander', 'astral codex ten'],
      authorItems: [
        { title: 'Open Thread 400', status: 'Skip', author: 'Scott Alexander' },
        { title: 'Open Thread 401', status: 'Skip', author: 'Scott Alexander' },
        { title: 'Open Thread 402', status: 'Skip', author: 'Scott Alexander' },
      ],
    })

    const score = await getSeriesScore('Open Thread', 'Scott Alexander', supabase)
    expect(score).toBe(-1.0)
  })
})

// ---------------------------------------------------------------------------
// getAuthorScore
// ---------------------------------------------------------------------------

describe('getAuthorScore', () => {
  it('returns engagement score from view for known author', async () => {
    const supabase = createMockSupabase({
      aliases: ['zvi mowshowitz', "don't worry about the vase"],
      engagementScores: [
        { engagement_score: 0.61, aliases: ['zvi mowshowitz', "don't worry about the vase"] },
        { engagement_score: 0.06, aliases: ['scott alexander', 'astral codex ten'] },
      ],
    })

    const score = await getAuthorScore('Zvi Mowshowitz', supabase)
    expect(score).toBe(0.61)
  })

  it('returns null for unknown author', async () => {
    const supabase = createMockSupabase({
      aliases: [],
      engagementScores: [
        { engagement_score: 0.61, aliases: ['zvi mowshowitz'] },
      ],
    })

    const score = await getAuthorScore('Unknown Author', supabase)
    expect(score).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getEngagementScore
// ---------------------------------------------------------------------------

describe('getEngagementScore', () => {
  it('returns series score when available', async () => {
    const supabase = createMockSupabase({
      aliases: ['zvi mowshowitz', "don't worry about the vase"],
      authorItems: [
        ...Array.from({ length: 16 }, (_, i) => ({
          title: `AI #${140 + i}: Episode`,
          status: 'Completed',
          author: 'Zvi Mowshowitz',
        })),
        { title: 'AI #156: Skipped', status: 'Skip', author: 'Zvi Mowshowitz' },
      ],
      engagementScores: [
        { engagement_score: 0.61, aliases: ['zvi mowshowitz', "don't worry about the vase"] },
      ],
    })

    const score = await getEngagementScore('AI #155: Test', 'Zvi Mowshowitz', supabase)
    // Should return series score (~0.88), not author score (0.61)
    expect(score).toBeCloseTo(15 / 17, 2)
  })

  it('falls back to author score when no series data', async () => {
    const supabase = createMockSupabase({
      aliases: ['scott alexander', 'astral codex ten'],
      authorItems: [
        // Only 1 item with this title pattern — not enough for series
        { title: 'Some Random Title', status: 'Completed', author: 'Scott Alexander' },
      ],
      engagementScores: [
        { engagement_score: 0.06, aliases: ['scott alexander', 'astral codex ten'] },
      ],
    })

    const score = await getEngagementScore('Some Random Title', 'Scott Alexander', supabase)
    expect(score).toBe(0.06)
  })

  it('returns 0.0 for unknown author', async () => {
    const supabase = createMockSupabase({
      aliases: [],
      authorItems: [],
      engagementScores: [],
    })

    const score = await getEngagementScore('Some Title', 'Unknown Author', supabase)
    expect(score).toBe(0.0)
  })

  it('returns series score for "Open Thread" by Scott Alexander', async () => {
    const supabase = createMockSupabase({
      aliases: ['scott alexander', 'astral codex ten'],
      authorItems: [
        { title: 'Open Thread 400', status: 'Skip', author: 'Scott Alexander' },
        { title: 'Open Thread 401', status: 'Skip', author: 'Scott Alexander' },
        { title: 'Open Thread 402', status: 'Skip', author: 'Scott Alexander' },
      ],
      engagementScores: [
        { engagement_score: 0.06, aliases: ['scott alexander', 'astral codex ten'] },
      ],
    })

    const score = await getEngagementScore('Open Thread 425', 'Scott Alexander', supabase)
    expect(score).toBe(-1.0)
  })
})

describe('extractSeriesKey ReDoS bounds (#281 F17)', () => {
  it('runs in linear time on long digit/space runs', () => {
    const start = performance.now()
    extractSeriesKey(`Series ${'1 '.repeat(60_000)}x`)
    extractSeriesKey(`Series ${'1 '.repeat(60_000)}`)
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('keeps stripping trailing number runs', () => {
    expect(extractSeriesKey('Monthly Roundup #35')).toBe('Monthly Roundup #')
    expect(extractSeriesKey('Links 2024/05/01')).toBe('Links')
  })
})
