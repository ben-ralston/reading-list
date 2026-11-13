import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractFinalText, buildPromptMessages, SUMMARY_MODEL } from './summary'
import { supabase } from './supabase'

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { stream: (...args: unknown[]) => streamMock(...args) }
  }
  return { default: MockAnthropic }
})

vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }))

const updateSpy = vi.fn()

function mockDb(item: Record<string, unknown>) {
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    if (table === 'content_sources') {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [{ platform: 'Substack', link: 'https://example.com/p' }], error: null }) }),
      }
    }
    return {
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: item, error: null }) }) }),
      update: (payload: unknown) => {
        updateSpy(payload)
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }
  }) as never)
}

function reply(content: unknown[], stop_reason = 'end_turn') {
  return { finalMessage: () => Promise.resolve({ content, stop_reason }) }
}

const OUTPUT = { one_liner: 'Core claim.', bullets: ['a', 'b', 'c', 'd'], source_access: 'full_text' }
const RECENT_ITEM = {
  id: 1, title: 'Post', summary: null, summary_data: null, summary_generated_at: null,
  published_on: '2026-09-25T00:00:00Z', created_at: '2026-09-26T00:00:00Z',
}

beforeEach(() => {
  streamMock.mockReset()
  updateSpy.mockReset()
})

describe('extractFinalText', () => {
  it('keeps only text after the last server-tool block', () => {
    const content = [
      { type: 'text', text: 'I have enough to write a blurb.' },
      { type: 'server_tool_use', id: '1', name: 'web_fetch', input: {} },
      { type: 'web_fetch_tool_result', tool_use_id: '1', content: {} },
      { type: 'text', text: '{"one_liner":' },
      { type: 'text', text: '"x"}' },
    ]
    expect(extractFinalText(content as never)).toBe('{"one_liner":"x"}')
  })

  it('returns all text when there are no tool blocks', () => {
    expect(extractFinalText([{ type: 'text', text: ' hi ' }] as never)).toBe('hi')
  })
})

describe('buildPromptMessages', () => {
  it('includes title and link for single source', () => {
    const messages = buildPromptMessages('The Pragmatic Programmer', [
      { platform: 'Substack', link: 'https://example.com/book' },
    ])
    expect(messages[0].content).toContain('The Pragmatic Programmer')
    expect(messages[0].content).toContain('https://example.com/book')
  })

  it('includes only title when no sources', () => {
    const messages = buildPromptMessages('The Pragmatic Programmer', [])
    expect(messages[0].content).toContain('The Pragmatic Programmer')
    expect(messages[0].content).not.toContain('Link')
  })

  it('labels non-Spotify as preferred when both sources exist', () => {
    const messages = buildPromptMessages('Interview with Author', [
      { platform: 'Substack', link: 'https://substack.com/article' },
      { platform: 'Spotify', link: 'https://open.spotify.com/episode/123' },
    ])
    const content = messages[0].content as string
    expect(content).toContain('Article/text link (preferred')
    expect(content).toContain('https://substack.com/article')
    expect(content).toContain('Audio version (Spotify)')
    expect(content).toContain('https://open.spotify.com/episode/123')
  })

  it('lists sources neutrally when no Spotify source', () => {
    const messages = buildPromptMessages('Article', [
      { platform: 'Substack', link: 'https://substack.com/a' },
      { platform: 'YouTube', link: 'https://youtube.com/b' },
    ])
    const content = messages[0].content as string
    expect(content).toContain('Link (Substack)')
    expect(content).toContain('Link (YouTube)')
  })
})

describe('generateSummary', () => {
  it('calls Opus 5.5 with structured output and stores one-liner + summary_data', async () => {
    mockDb(RECENT_ITEM)
    streamMock.mockReturnValue(reply([{ type: 'text', text: JSON.stringify(OUTPUT) }]))
    const { generateSummary } = await import('./summary')

    const result = await generateSummary(1)

    const params = streamMock.mock.calls[0][0]
    expect(params.model).toBe('claude-opus-5-5')
    expect(params.thinking).toBeUndefined()
    // Thinking can't be disabled on Opus 5.5 and counts against max_tokens;
    // 16000 truncated a long ACX essay in the #304 backfill.
    expect(params.max_tokens).toBe(32000)
    expect(params.output_config.effort).toBe('medium')
    expect(params.output_config.format.type).toBe('json_schema')
    expect(params.tools.map((t: { type: string }) => t.type)).toEqual(['web_search_20260209', 'web_fetch_20260209'])
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      summary: 'Core claim.',
      summary_data: { ...OUTPUT, model: SUMMARY_MODEL, version: 2 },
    }))
    expect(result.summary).toBe('Core claim.')
    expect(result.summaryData).toEqual({ oneLiner: 'Core claim.', bullets: ['a', 'b', 'c', 'd'], sourceAccess: 'full_text', model: SUMMARY_MODEL })
    expect(result.generatedAt).toBeTruthy()
  })

  it('continues after pause_turn by replaying the assistant content', async () => {
    mockDb(RECENT_ITEM)
    const paused = [{ type: 'server_tool_use', id: '1', name: 'web_search', input: { query: 'q' } }]
    streamMock
      .mockReturnValueOnce(reply(paused, 'pause_turn'))
      .mockReturnValueOnce(reply([{ type: 'text', text: JSON.stringify(OUTPUT) }]))
    const { generateSummary } = await import('./summary')

    await generateSummary(1)

    expect(streamMock).toHaveBeenCalledTimes(2)
    const second = streamMock.mock.calls[1][0]
    expect(second.messages.at(-1)).toEqual({ role: 'assistant', content: paused })
    expect(updateSpy).toHaveBeenCalledOnce()
  })

  it('throws and writes nothing on a refusal', async () => {
    mockDb(RECENT_ITEM)
    streamMock.mockReturnValue(reply([], 'refusal'))
    const { generateSummary } = await import('./summary')
    await expect(generateSummary(1)).rejects.toThrow('refused')
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('throws and writes nothing on max_tokens', async () => {
    mockDb(RECENT_ITEM)
    streamMock.mockReturnValue(reply([{ type: 'text', text: '{"one_' }], 'max_tokens'))
    const { generateSummary } = await import('./summary')
    await expect(generateSummary(1)).rejects.toThrow('truncated')
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('throws and writes nothing on unparseable output', async () => {
    mockDb(RECENT_ITEM)
    streamMock.mockReturnValue(reply([{ type: 'text', text: 'Good, full content retrieved.' }]))
    const { generateSummary } = await import('./summary')
    await expect(generateSummary(1)).rejects.toThrow('not valid JSON')
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('auto mode skips back-catalog items without calling the model', async () => {
    mockDb({ ...RECENT_ITEM, published_on: '1996-11-17T12:00:00Z', created_at: '2026-09-23T14:15:00Z' })
    const { generateSummary } = await import('./summary')
    const result = await generateSummary(1, { skipExisting: true, auto: true })
    expect(streamMock).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(result.summaryData).toBeNull()
  })

  it('auto mode still generates for recent items', async () => {
    mockDb(RECENT_ITEM)
    streamMock.mockReturnValue(reply([{ type: 'text', text: JSON.stringify(OUTPUT) }]))
    const { generateSummary } = await import('./summary')
    await generateSummary(1, { skipExisting: true, auto: true })
    expect(streamMock).toHaveBeenCalledOnce()
  })

  it('manual generation ignores the back-catalog guard', async () => {
    mockDb({ ...RECENT_ITEM, published_on: '1996-11-17T12:00:00Z', created_at: '2026-09-23T14:15:00Z' })
    streamMock.mockReturnValue(reply([{ type: 'text', text: JSON.stringify(OUTPUT) }]))
    const { generateSummary } = await import('./summary')
    await generateSummary(1)
    expect(streamMock).toHaveBeenCalledOnce()
  })
})
