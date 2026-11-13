import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyAndOpen } from './handoff'

describe('copyAndOpen', () => {
  const openSpy = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('window', { open: openSpy })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('copies the text and opens the app URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const result = await copyAndOpen('https://example.com/post', 'https://app.example/')
    expect(result).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('https://example.com/post')
    expect(openSpy).toHaveBeenCalledWith('https://app.example/', '_blank', 'noopener,noreferrer')
  })

  it('returns opened when the clipboard write throws', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
    })
    await expect(copyAndOpen('u', 'a')).resolves.toBe('opened')
    expect(openSpy).toHaveBeenCalled()
  })

  it('returns opened when no clipboard API exists', async () => {
    vi.stubGlobal('navigator', {})
    await expect(copyAndOpen('u', 'a')).resolves.toBe('opened')
  })
})
