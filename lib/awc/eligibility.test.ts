import { describe, it, expect } from 'vitest'
import type { QueueItem, ContentSource } from '@/lib/queue-client'
import { articleSource, canConvertCommentsWithAwc, canConvertWithAwc, hasAwcAudio, hasAwcCommentsAudio } from './eligibility'

const source = (o: Partial<ContentSource>): ContentSource => ({
  id: 1, platform: 'Substack', link: 'https://ex.com/p', messageId: null, isPrimary: false, createdAt: 'c', sourceLabel: null, ...o,
})
const item = (...sources: ContentSource[]) => ({ sources }) as QueueItem

const spotify = source({ id: 2, platform: 'Spotify', link: 'https://open.spotify.com/episode/x', isPrimary: true })
const article = source({ id: 3, platform: 'Substack', link: 'https://ex.com/p' })
const privateEpisode = source({ id: 4, platform: 'Askwho Casts', link: 'https://app.askwhocasts.com/f/s/media/x.mp3' })
const publicCopy = source({ id: 5, platform: 'Spotify', link: 'https://open.spotify.com/episode/y', sourceLabel: 'AI Article Readings' })

describe('articleSource', () => {
  it('finds the article behind a Spotify primary', () => {
    expect(articleSource(item(spotify, article))?.link).toBe('https://ex.com/p')
  })
  it('prefers the primary source when it is an article', () => {
    const primary = source({ id: 6, platform: 'Web', link: 'https://primary.com/a', isPrimary: true })
    expect(articleSource(item(source({ id: 7, platform: 'LessWrong', link: 'https://lw.com/a' }), primary))?.link).toBe('https://primary.com/a')
  })
  it('otherwise follows queue priority', () => {
    const web = source({ id: 8, platform: 'Web', link: 'https://web.com/a' })
    const lw = source({ id: 9, platform: 'LessWrong', link: 'https://lw.com/a' })
    expect(articleSource(item(spotify, web, lw))?.link).toBe('https://lw.com/a')
  })
  it.each([
    ['audio only', [spotify]],
    ['a non-http link', [source({ link: 'mailto:a@b.c' })]],
    ['no link', [source({ link: null })]],
    ['no sources', []],
  ])('returns null for %s', (_name, sources) => {
    expect(articleSource(item(...sources))).toBeNull()
  })
})

describe('hasAwcAudio', () => {
  it('is true for a private episode and for a public show copy', () => {
    expect(hasAwcAudio(item(article, privateEpisode))).toBe(true)
    expect(hasAwcAudio(item(article, publicCopy))).toBe(true)
  })
  it('is false for other Spotify audio', () => {
    expect(hasAwcAudio(item(article, spotify))).toBe(false)
    expect(hasAwcAudio(item(article, source({ platform: 'Spotify', sourceLabel: 'Some Show' })))).toBe(false)
  })
})

describe('canConvertWithAwc', () => {
  it('offers Convert on a post with Spotify audio and an article', () => {
    expect(canConvertWithAwc(item(spotify, article), false)).toBe(true)
  })
  it('offers Convert on a plain text post', () => {
    expect(canConvertWithAwc(item(article), false)).toBe(true)
  })
  it.each([
    ['a podcast episode with no article', item(spotify), false],
    ['a book', item(article), true],
    ['a post with a private episode', item(spotify, article, privateEpisode), false],
    ['a post with a public copy', item(article, publicCopy), false],
  ])('does not offer it on %s', (_name, candidate, isBooks) => {
    expect(canConvertWithAwc(candidate, isBooks)).toBe(false)
  })
})

describe('comments conversions (#368)', () => {
  const post = source({ id: 10, platform: 'LessWrong', link: 'https://www.lesswrong.com/posts/abc/title', isPrimary: true })
  const commentsEpisode = source({ id: 11, platform: 'Askwho Casts', link: 'https://app.askwhocasts.com/f/s/media/c.mp3', sourceLabel: 'Comments' })

  it('offers it on a LessWrong post', () => {
    expect(canConvertCommentsWithAwc(item(post), false)).toBe(true)
  })
  it('offers it on a post that already has an article episode', () => {
    expect(canConvertCommentsWithAwc(item(post, privateEpisode), false)).toBe(true)
  })
  it.each([
    ['a Substack post', [article]],
    ['a podcast with no article', [spotify]],
    ['a LessWrong non-post link', [source({ platform: 'LessWrong', link: 'https://www.lesswrong.com/users/x' })]],
    ['a post that has its comments episode', [post, commentsEpisode]],
  ])('does not offer it on %s', (_name, sources) => {
    expect(canConvertCommentsWithAwc(item(...sources), false)).toBe(false)
  })
  it('does not offer it on a book', () => {
    expect(canConvertCommentsWithAwc(item(post), true)).toBe(false)
  })
  it('keeps the article convertible when only a comments episode exists', () => {
    expect(hasAwcAudio(item(post, commentsEpisode))).toBe(false)
    expect(hasAwcCommentsAudio(item(post, commentsEpisode))).toBe(true)
    expect(canConvertWithAwc(item(post, commentsEpisode), false)).toBe(true)
  })
})
