import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scoreToRank, insertAtSmartPosition } from './queue-position'

// Mock the engagement module
vi.mock('./engagement', () => ({
  getEngagementScore: vi.fn(),
}))

import { getEngagementScore } from './engagement'

const mockGetEngagementScore = vi.mocked(getEngagementScore)

// ---------------------------------------------------------------------------
// scoreToRank (pure function — no mocks needed)
// ---------------------------------------------------------------------------

describe('scoreToRank', () => {
  it('returns 2 for empty queue regardless of score', () => {
    expect(scoreToRank(1.0, 0)).toBe(2)
    expect(scoreToRank(0.0, 0)).toBe(2)
    expect(scoreToRank(-1.0, 0)).toBe(2)
  })

  it('places score +1.0 at position 2 (front)', () => {
    expect(scoreToRank(1.0, 10)).toBe(2)
  })

  it('places score -1.0 at last position (queueSize + 1)', () => {
    expect(scoreToRank(-1.0, 10)).toBe(11)
  })

  it('places score 0.0 in the middle', () => {
    // position = 2 + round((1 - 0) / 2 * 9) = 2 + round(4.5) = 2 + 5 = 7
    expect(scoreToRank(0.0, 10)).toBe(7)
  })

  it('places high positive score near front', () => {
    // score 0.9, queueSize 10: position = 2 + round((1 - 0.9) / 2 * 9) = 2 + round(0.45) = 2 + 0 = 2
    expect(scoreToRank(0.9, 10)).toBe(2)
  })

  it('places moderate score in upper-middle', () => {
    // score 0.5, queueSize 10: position = 2 + round((1 - 0.5) / 2 * 9) = 2 + round(2.25) = 2 + 2 = 4
    expect(scoreToRank(0.5, 10)).toBe(4)
  })

  it('handles small queue (1 item)', () => {
    // queueSize 1: position = 2 + round((1 - score) / 2 * 0) = 2
    expect(scoreToRank(1.0, 1)).toBe(2)
    expect(scoreToRank(0.0, 1)).toBe(2)
    expect(scoreToRank(-1.0, 1)).toBe(2)
  })

  it('clamps to minimum position 2', () => {
    // Even with score > 1.0 (shouldn't happen, but be safe)
    expect(scoreToRank(2.0, 10)).toBe(2)
  })

  it('clamps to maximum position queueSize + 1', () => {
    // Even with score < -1.0 (shouldn't happen, but be safe)
    expect(scoreToRank(-2.0, 10)).toBe(11)
  })
})

// ---------------------------------------------------------------------------
// insertAtSmartPosition
// ---------------------------------------------------------------------------

// RLV-004 (#203): placement must be a single atomic RPC (shift + place in one
// transaction, serialized by an advisory lock) — the old JS read->shift->write
// raced concurrent placements and produced duplicate positions.

describe('insertAtSmartPosition', () => {
  beforeEach(() => {
    mockGetEngagementScore.mockClear()
  })

  function makeSupabase(count: number, placedAt = 42) {
    // The RPC resolves the rank under its lock and returns the placed position.
    const rpcMock = vi.fn().mockResolvedValue({ data: placedAt, error: null })
    const supabase = {
      rpc: rpcMock,
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'content_items') {
          return {
            select: vi.fn().mockReturnValue({
              // Count query: .eq('kind', kind).not('queue_position', 'is', null)
              eq: vi.fn().mockReturnThis(),
              not: vi.fn().mockResolvedValue({ count, error: null }),
            }),
          }
        }
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) }
      }),
    } as any
    return { supabase, rpcMock }
  }

  it('places a high-score item near the front via one place_item_in_queue call', async () => {
    mockGetEngagementScore.mockResolvedValueOnce(0.9)
    const { supabase, rpcMock } = makeSupabase(5)

    // score 0.9, queueSize 5: position = 2 + round((1-0.9)/2 * 4) = 2
    const position = await insertAtSmartPosition(99, 'New Item', 'Author', supabase)

    expect(position).toBe(42) // the position the RPC placed it at
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('place_item_in_queue', {
      p_item_id: 99,
      p_kind: 'feed',
      p_target_position: null,
      p_target_rank: 2,
      p_position_confirmed: false,
    })
  })

  it('places a low-score item near the end of the queue', async () => {
    mockGetEngagementScore.mockResolvedValueOnce(-1.0)
    const { supabase, rpcMock } = makeSupabase(10)

    // score -1.0, queueSize 10: position = 2 + round((1-(-1))/2 * 9) = 11
    const position = await insertAtSmartPosition(99, 'Skippable Item', 'Bad Author', supabase)

    expect(position).toBe(42) // the position the RPC placed it at
    expect(rpcMock).toHaveBeenCalledWith('place_item_in_queue', {
      p_item_id: 99,
      p_kind: 'feed',
      p_target_position: null,
      p_target_rank: 11,
      p_position_confirmed: false,
    })
  })

  it('handles an empty queue (rank 2)', async () => {
    mockGetEngagementScore.mockResolvedValueOnce(0.5)
    const { supabase, rpcMock } = makeSupabase(0)

    const position = await insertAtSmartPosition(99, 'New Item', 'Author', supabase)

    expect(position).toBe(42) // the position the RPC placed it at
    expect(rpcMock).toHaveBeenCalledWith('place_item_in_queue', {
      p_item_id: 99,
      p_kind: 'feed',
      p_target_position: null,
      p_target_rank: 2,
      p_position_confirmed: false,
    })
  })

  it('manual requests pin to rank 2, confirmed, without scoring — kind-scoped', async () => {
    const { supabase, rpcMock } = makeSupabase(0)

    const position = await insertAtSmartPosition(99, 'Wanted Book', 'Author', supabase, true, 'book')

    expect(position).toBe(42) // the position the RPC placed it at
    expect(rpcMock).toHaveBeenCalledWith('place_item_in_queue', {
      p_item_id: 99,
      p_kind: 'book',
      p_target_position: null,
      p_target_rank: 2,
      p_position_confirmed: true,
    })
    expect(mockGetEngagementScore).not.toHaveBeenCalled()
  })
})
