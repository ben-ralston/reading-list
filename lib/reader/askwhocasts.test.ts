import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendToAskwhoCasts, ASKWHOCASTS_URL } from './askwhocasts'

describe('sendToAskwhoCasts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('copies the article URL and opens the Askwho Casts app', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('window', { open })
    const result = await sendToAskwhoCasts('https://blog.example/post')
    expect(result).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('https://blog.example/post')
    expect(open).toHaveBeenCalledWith(ASKWHOCASTS_URL, '_blank', 'noopener,noreferrer')
  })
})
