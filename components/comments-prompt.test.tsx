import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { CommentsPrompt } from './comments-prompt'
import type { QueueItem } from '@/lib/queue-client'

const lw = { id: 1, platform: 'LessWrong', link: 'https://www.lesswrong.com/posts/abc/title', messageId: null, isPrimary: true, createdAt: 'c', sourceLabel: null }
const episode = { id: 2, platform: 'Askwho Casts', link: 'https://app.askwhocasts.com/f/SECRET/media/c.mp3', messageId: null, isPrimary: false, createdAt: 'c', sourceLabel: 'Comments' }
const item = (sources: unknown[], status = 'Awaiting comments') => ({ id: 5, status, sources }) as unknown as QueueItem
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CommentsPrompt (#368)', () => {
  it('links to the comments episode once it exists', () => {
    render(<CommentsPrompt item={item([lw, episode])} onDone={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'Listen to comments' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open comments' })).toBeTruthy()
  })
  it('opens the Podcasts Library on iOS, never the audio file with its feed secret', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5 })
    render(<CommentsPrompt item={item([lw, episode])} onDone={vi.fn()} />)
    const href = screen.getByRole('link', { name: 'Listen to comments' }).getAttribute('href')
    expect(href).toContain('podcasts.apple.com/library')
    expect(href).not.toContain('SECRET')
  })
  it('leaves the audio link out of the server render, which holds the feed secret', () => {
    const html = renderToString(<CommentsPrompt item={item([lw, episode])} onDone={vi.fn()} />)
    expect(html).toContain('Open comments')
    expect(html).not.toContain('Listen to comments')
    expect(html).not.toContain('SECRET')
  })
  it('has no link without the episode, or for an article episode', () => {
    render(<CommentsPrompt item={item([lw, { ...episode, sourceLabel: null }])} onDone={vi.fn()} />)
    expect(screen.queryByRole('link', { name: 'Listen to comments' })).toBeNull()
  })
  it('stays hidden on other statuses', () => {
    render(<CommentsPrompt item={item([lw, episode], 'In Progress')} onDone={vi.fn()} />)
    expect(screen.queryByRole('link', { name: 'Listen to comments' })).toBeNull()
  })
})
