// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { resultDetail, toolTrace } from './trace'

const use = (name: string, input: object) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hm' }, { type: 'tool_use', name, input }] } })

describe('toolTrace', () => {
  it('counts tool calls and lists what was fetched and searched', () => {
    const stream = [
      use('Read', { file_path: 'queue.jsonl' }), use('Grep', { pattern: 'Zvi' }), use('Read', { file_path: 'memory.md' }),
      use('WebFetch', { url: 'https://example.com/a\u001b[31m', prompt: 'p' }), use('WebSearch', { query: 'machine  gods\npodcast' }),
      'noise', JSON.stringify({ type: 'result', subtype: 'success' }),
    ].join('\n')
    expect(toolTrace(stream)).toEqual({
      counts: { Read: 2, Grep: 1, WebFetch: 1, WebSearch: 1 },
      fetched: ['https://example.com/a [31m'],
      searched: ['machine gods podcast'],
    })
  })

  it('is empty for a stream with no tool use', () => {
    expect(toolTrace('')).toEqual({ counts: {}, fetched: [], searched: [] })
  })
})

describe('resultDetail', () => {
  it('describes the last result event in one short line', () => {
    const stream = ['noise', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key\n\u001b[31mplease run /login ' + 'x'.repeat(300) })].join('\n')
    const detail = resultDetail(stream)!
    expect(detail.startsWith('claude ended: success: Invalid API key [31mplease run /login')).toBe(true)
    expect(detail.length).toBeLessThanOrEqual(120)
  })

  it('handles a result with no text, and no result at all', () => {
    expect(resultDetail(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))).toBe('claude ended: error_max_turns')
    expect(resultDetail('garbage')).toBeNull()
  })
})
