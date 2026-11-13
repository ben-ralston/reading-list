import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  sendToElevenReader,
  canListenInReader,
  iosShortcutLaunchUrl,
  ELEVENREADER_URL,
} from './elevenreader'
import type { ContentSource, QueueItem } from '@/lib/queue-client'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

function src(platform: string, link: string | null): ContentSource {
  return { id: 1, platform, link, messageId: null, isPrimary: true, createdAt: 'c', sourceLabel: null }
}
function itemWith(sources: ContentSource[]): QueueItem {
  return { sources } as QueueItem
}

describe('canListenInReader', () => {
  it('stays available when the post only has a comments episode (#368)', () => {
    const episode = { ...src('Askwho Casts', 'https://app.askwhocasts.com/c.mp3'), id: 2, isPrimary: false, sourceLabel: 'Comments' }
    expect(canListenInReader(itemWith([src('LessWrong', 'https://www.lesswrong.com/posts/a/b'), episode]), false)).toBe(true)
  })
  it('is true for a text feed item with an http(s) link', () => {
    expect(canListenInReader(itemWith([src('Substack', 'https://x.com/p')]), false)).toBe(true)
  })

  it('is false for a book', () => {
    expect(canListenInReader(itemWith([src('Substack', 'https://x.com/p')]), true)).toBe(false)
  })

  it('is false when any source is a native-audio platform', () => {
    expect(canListenInReader(itemWith([src('Spotify', 'https://x.com/p')]), false)).toBe(false)
  })

  it('is false when the primary source has no http link', () => {
    expect(canListenInReader(itemWith([src('Physical', null)]), false)).toBe(false)
  })
})

describe('iosShortcutLaunchUrl', () => {
  it('returns the shortcuts:// run-shortcut URL on iPhone', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5 })
    expect(iosShortcutLaunchUrl()).toBe('shortcuts://run-shortcut?name=Open%20ElevenReader')
  })

  it('returns the URL on iPadOS (Macintosh UA + touch points)', () => {
    vi.stubGlobal('navigator', { userAgent: MAC_UA, maxTouchPoints: 5 })
    expect(iosShortcutLaunchUrl()).toBe('shortcuts://run-shortcut?name=Open%20ElevenReader')
  })

  it('returns null on a desktop Mac (no touch points)', () => {
    vi.stubGlobal('navigator', { userAgent: MAC_UA, maxTouchPoints: 0 })
    expect(iosShortcutLaunchUrl()).toBeNull()
  })

  it('returns null on a non-Apple desktop', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
      maxTouchPoints: 0,
    })
    expect(iosShortcutLaunchUrl()).toBeNull()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendToElevenReader', () => {
  it('uses the Web Share API with a URL-only payload when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    vi.stubGlobal('navigator', { share, canShare: () => true })
    vi.stubGlobal('open', open)

    const result = await sendToElevenReader('https://example.com/post')

    expect(share).toHaveBeenCalledWith({ url: 'https://example.com/post' })
    expect(result).toBe('shared')
    expect(open).not.toHaveBeenCalled()
  })

  it('returns "cancelled" when the user dismisses the share sheet, without copying', async () => {
    const abort = Object.assign(new Error('share cancelled'), { name: 'AbortError' })
    const share = vi.fn().mockRejectedValue(abort)
    const writeText = vi.fn()
    const open = vi.fn()
    vi.stubGlobal('navigator', { share, canShare: () => true, clipboard: { writeText } })
    vi.stubGlobal('open', open)

    const result = await sendToElevenReader('https://example.com/post')

    expect(result).toBe('cancelled')
    expect(writeText).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('falls back to clipboard + opening ElevenReader when share is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('open', open)

    const result = await sendToElevenReader('https://example.com/post')

    expect(writeText).toHaveBeenCalledWith('https://example.com/post')
    expect(open).toHaveBeenCalledWith(ELEVENREADER_URL, '_blank', 'noopener,noreferrer')
    expect(result).toBe('copied')
  })

  it('falls back to clipboard + open when share throws a non-abort error', async () => {
    const share = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    vi.stubGlobal('navigator', { share, canShare: () => true, clipboard: { writeText } })
    vi.stubGlobal('open', open)

    const result = await sendToElevenReader('https://example.com/post')

    expect(writeText).toHaveBeenCalledWith('https://example.com/post')
    expect(open).toHaveBeenCalledWith(ELEVENREADER_URL, '_blank', 'noopener,noreferrer')
    expect(result).toBe('copied')
  })

  it('falls back to clipboard when canShare rejects the payload', async () => {
    const share = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    vi.stubGlobal('navigator', { share, canShare: () => false, clipboard: { writeText } })
    vi.stubGlobal('open', open)

    const result = await sendToElevenReader('https://example.com/post')

    expect(share).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('https://example.com/post')
    expect(result).toBe('copied')
  })

  it('returns "opened" (not "copied") when the Clipboard API is unavailable', async () => {
    const open = vi.fn()
    vi.stubGlobal('navigator', {}) // no share, no clipboard
    vi.stubGlobal('open', open)

    const result = await sendToElevenReader('https://example.com/post')

    expect(open).toHaveBeenCalledWith(ELEVENREADER_URL, '_blank', 'noopener,noreferrer')
    expect(result).toBe('opened')
  })

  it('returns "opened" when the clipboard write is blocked, still opening ElevenReader', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const open = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('open', open)

    const result = await sendToElevenReader('https://example.com/post')

    expect(writeText).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith(ELEVENREADER_URL, '_blank', 'noopener,noreferrer')
    expect(result).toBe('opened')
  })
})
