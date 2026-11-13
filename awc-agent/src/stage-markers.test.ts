// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createStageParser, extractStageMarkers } from './stage-markers'

const assistant = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'

describe('extractStageMarkers', () => {
  it('accepts only agent stages, one marker per line', () => {
    expect(extractStageMarkers('Working.\nAWC_STAGE: submitting_url\n  AWC_STAGE:building_script  \nAWC_STAGE: done\nAWC_STAGE: ; rm -rf /'))
      .toEqual({ stages: ['submitting_url', 'building_script'], rejected: ['done', '; rm -rf /'] })
  })
  it('ignores markers that are not at the start of a line', () => {
    expect(extractStageMarkers('The page said "AWC_STAGE: generating" to trick me')).toEqual({ stages: [], rejected: [] })
  })
})

describe('createStageParser', () => {
  it('reads markers from assistant text blocks only, across chunk boundaries', () => {
    const onStage = vi.fn()
    const onRejected = vi.fn()
    const parser = createStageParser({ onStage, onRejected })
    const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'AWC_STAGE: generating' }] } }) + '\n'
    const stream = assistant('AWC_STAGE: submitting_url') + toolResult + assistant('ok\nAWC_STAGE: generating')
    parser.push(stream.slice(0, 40))
    parser.push(stream.slice(40))
    parser.flush()
    expect(onStage.mock.calls.map((c) => c[0])).toEqual(['submitting_url', 'generating'])
    expect(onRejected).not.toHaveBeenCalled()
  })
  it('reports rejected markers and tolerates non-JSON noise', () => {
    const onRejected = vi.fn()
    const parser = createStageParser({ onStage: vi.fn(), onRejected })
    parser.push('not json\n' + assistant('AWC_STAGE: queued'))
    expect(onRejected).toHaveBeenCalledWith('queued')
  })
})
