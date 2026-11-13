import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, within, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { ReadingList, QueueItemCard } from './reading-list'
import { transformToDisplayItem } from '@/lib/transform-utils'
import type { QueueItem } from '@/lib/queue-client'

// Minimal feed item factory — only the fields ReadingList reads need to be real.
function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    title: 'Test Item',
    author: 'Test Author',
    publishedOn: null,
    status: '',
    queuePosition: 1,
    positionConfirmed: true,
    progress: null,
    addedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    statusChangedAt: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 1, platform: 'Substack', link: 'https://example.com/a', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
    ],
    platform: 'Substack',
    link: 'https://example.com/a',
    ...overrides,
  }
}

const noop = async () => {}

// Every prop ReadingList requires, with inert defaults — individual tests
// spread this and override what they exercise.
function baseProps() {
  return {
    onMarkComplete: noop,
    onSkip: noop,
    onToggleStarted: noop,
    onStartItem: noop,
    onMakeNext: noop,
    onReorder: noop,
    onRefresh: vi.fn(),
    sortDirection: 'queue' as const,
    onSortChange: vi.fn(),
    mediaFilter: 'all' as const,
    onMediaFilterChange: vi.fn(),
    mediaCounts: { all: 2, audio: 0, text: 2 },
    authorOptions: [],
    selectedAuthors: [],
    onSelectedAuthorsChange: vi.fn(),
    readStateOptions: [],
    selectedReadStates: [],
    onSelectedReadStatesChange: vi.fn(),
    searchQuery: '',
    onSearchQueryChange: vi.fn(),
    isAddDialogOpen: false,
    onAddDialogOpenChange: vi.fn(),
  }
}

function renderList(
  items: QueueItem[],
  overrides: Partial<ComponentProps<typeof ReadingList>> = {},
) {
  return render(<ReadingList items={items} {...baseProps()} {...overrides} />)
}

describe('ReadingList hero (top item) action row', () => {
  it('stretches the Complete and Skip buttons full-width, matching the Resume button', () => {
    const { getByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
    ])

    // The Resume/Start primary control establishes the full-width treatment.
    // (It renders as an anchor since #197 so iOS universal links work.)
    const resume = getByRole('link', { name: /START|RESUME/ })
    expect(resume.classList.contains('flex-1')).toBe(true)

    // The Complete and Skip buttons must use the same flex-1 stretch so the
    // action row fills the full content width (issue #181). A fixed px-6
    // content-width button leaves the row short on the right.
    const complete = getByRole('button', { name: 'Complete' })
    const skip = getByRole('button', { name: 'Skip' })
    expect(complete.classList.contains('flex-1')).toBe(true)
    expect(skip.classList.contains('flex-1')).toBe(true)
  })
})

describe('ReadingList external links open via real anchors (#197)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // iOS only hands a URL off to a native app (universal links) on a genuine
  // <a href> tap, so the "Open on …" actions must be real anchors, not
  // window.open handlers.
  it('renders the list-card menu "Open on {platform}" item as an anchor with the source link', () => {
    const { getAllByRole, getByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({
        id: 2,
        title: 'Second Item',
        queuePosition: 2,
        sources: [
          { id: 2, platform: 'LessWrong', link: 'https://www.lesswrong.com/posts/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
        ],
        platform: 'LessWrong',
        link: 'https://www.lesswrong.com/posts/x',
      }),
    ])

    // Menu triggers in DOM order: header sort, hero ⋯, list-card ⋯ (the hero
    // alt-sources menu needs 2+ sources and isn't rendered here) — so the
    // list card's trigger is the last one.
    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    const item = getByRole('menuitem', { name: /Open on LessWrong/ })
    expect(item.tagName).toBe('A')
    expect(item.getAttribute('href')).toBe('https://www.lesswrong.com/posts/x')
    expect(item.getAttribute('target')).toBe('_blank')
    expect(item.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders the hero START/RESUME control as an anchor that still marks the item started', () => {
    const onStartItem = vi.fn()
    const { getByRole } = renderList(
      [
        makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
        makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
      ],
      { onStartItem },
    )

    const start = getByRole('link', { name: /START|RESUME/ })
    expect(start.getAttribute('href')).toBe('https://example.com/a')
    expect(start.getAttribute('target')).toBe('_blank')
    expect(start.getAttribute('rel')).toBe('noopener noreferrer')

    fireEvent.click(start)
    expect(onStartItem).toHaveBeenCalledTimes(1)
    expect(onStartItem.mock.calls[0][0].id).toBe(1)
  })

  it('renders hero alternate-source menu items as anchors that still mark the item started', () => {
    const onStartItem = vi.fn()
    const { getByRole } = renderList(
      [
        makeItem({
          id: 1,
          title: 'Top Item',
          queuePosition: 1,
          sources: [
            { id: 1, platform: 'Substack', link: 'https://pub.substack.com/p/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
            { id: 2, platform: 'Spotify', link: 'https://open.spotify.com/episode/y', messageId: null, isPrimary: false, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
          ],
        }),
        makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
      ],
      { onStartItem, mediaCounts: { all: 2, audio: 1, text: 1 } },
    )

    // The alt-sources trigger is the menu button sharing the hero action row
    // with the START anchor (index-based selection is fragile — the header
    // also has settings + sort menus).
    const startRow = getByRole('link', { name: /START|RESUME/ }).closest('div')!
    const altTrigger = startRow.querySelector('button[aria-haspopup="menu"]')!
    fireEvent.pointerDown(altTrigger, { button: 0, ctrlKey: false })

    const item = getByRole('menuitem', { name: /Open on Spotify/ })
    expect(item.tagName).toBe('A')
    expect(item.getAttribute('href')).toBe('https://open.spotify.com/episode/y')
    expect(item.getAttribute('target')).toBe('_blank')
    expect(item.getAttribute('rel')).toBe('noopener noreferrer')

    fireEvent.click(item)
    expect(onStartItem).toHaveBeenCalledTimes(1)
    expect(onStartItem.mock.calls[0][0].id).toBe(1)
  })

  it('keeps the hero START control a plain button (no navigation) when the primary link is not http', () => {
    const onStartItem = vi.fn()
    const physicalSource = { id: 3, platform: 'Physical', link: null, messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null }
    const { getByRole, queryByRole } = renderList(
      [
        makeItem({ id: 1, title: 'Hero Book', queuePosition: 1, kind: 'book', sources: [physicalSource], platform: 'Physical', link: '' }),
        makeItem({ id: 2, title: 'Card Book', queuePosition: 2, kind: 'book', sources: [{ ...physicalSource, id: 4 }], platform: 'Physical', link: '' }),
      ],
      { onStartItem, kind: 'book' },
    )

    expect(queryByRole('link', { name: /START|RESUME/ })).toBeNull()
    const start = getByRole('button', { name: /START|RESUME/ })
    fireEvent.click(start)
    expect(onStartItem).toHaveBeenCalledTimes(1)
  })

  it('applies the x-safari escape hydration-safely in the iOS standalone PWA', () => {
    // The page is SSR'd (app/page.tsx is force-dynamic), where navigator is
    // unavailable and externalHref returns the plain URL. The first client
    // render must match that HTML or React logs a hydration mismatch and
    // re-renders — on exactly the platform this feature targets. The prefix
    // may only appear after hydration.
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
      standalone: true,
    })

    const items = [
      makeItem({
        id: 1, title: 'Top Item', queuePosition: 1,
        sources: [{ id: 1, platform: 'Website', link: 'https://example.com/a', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null }],
        platform: 'Website', link: 'https://example.com/a',
      }),
      makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
    ]
    const el = <ReadingList items={items} {...baseProps()} />

    // Server pass: plain URL, no x-safari prefix anywhere.
    const ssrHtml = renderToString(el)
    expect(ssrHtml).not.toContain('x-safari-')
    expect(ssrHtml).toContain('href="https://example.com/a"')

    // Hydrated client: the hero anchor carries the Safari-escape href.
    const { getByRole } = render(el)
    expect(getByRole('link', { name: /START|RESUME/ }).getAttribute('href'))
      .toBe('x-safari-https://example.com/a')
  })

  it('keeps link-less book sources as a disabled non-link menu entry', () => {
    const physical = {
      kind: 'book' as const,
      sources: [
        { id: 3, platform: 'Physical', link: null, messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
      ],
      platform: 'Physical',
      link: '',
    }
    const { getAllByRole, getByRole } = renderList(
      [
        makeItem({ id: 1, queuePosition: 1, title: 'Hero Book', ...physical }),
        makeItem({ id: 2, queuePosition: 2, title: 'Card Book', ...physical, sources: [{ ...physical.sources[0], id: 4 }] }),
      ],
      { kind: 'book' },
    )
    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    // The platform renders as a plain disabled entry, not an "Open on" link.
    const menu = within(getByRole('menu'))
    expect(menu.getByText('Physical')).toBeTruthy()
    expect(menu.queryByRole('menuitem', { name: /Open on/ })).toBeNull()
    expect(menu.getByRole('menuitem', { name: 'Physical' }).tagName).not.toBe('A')
  })
})

describe('Resume on Spotify (#194)', () => {
  const dualSourceOverrides = (id: number): Partial<QueueItem> => ({
    id,
    status: 'In Progress',
    progress: '45',
    durationSeconds: 3600,
    sources: [
      // Read position 45 vs Spotify's own 10 → disagreement gate shows the
      // action; the seek target comes from the per-source 45 (#194).
      { id: id * 10, platform: 'Substack', link: 'https://pub.substack.com/p/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', progress: 45, sourceLabel: null },
      { id: id * 10 + 1, platform: 'Spotify', link: 'https://open.spotify.com/episode/abc123', messageId: null, isPrimary: false, createdAt: '2026-01-01T00:00:00Z', externalId: 'spotify:episode:abc123', progress: 10, sourceLabel: null },
    ],
  })

  it('shows the resume anchor with the computed timestamp in the list-card menu', () => {
    const { getAllByRole, getByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({ ...dualSourceOverrides(2), title: 'Second Item', queuePosition: 2 }),
    ])

    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    const item = getByRole('menuitem', { name: /Resume on Spotify \(~27:00\)/ })
    expect(item.tagName).toBe('A')
    expect(item.getAttribute('href')).toBe('https://open.spotify.com/episode/abc123?t=1620')
    expect(item.getAttribute('target')).toBe('_blank')
    expect(item.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('shows the resume anchor in the hero actions menu', () => {
    const { getByRole } = renderList([
      makeItem({ ...dualSourceOverrides(1), title: 'Top Item', queuePosition: 1 }),
      makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
    ])

    // The hero actions ⋯ shares its row with the Complete and Skip buttons
    // (the alt-sources ⋯ sits next to the START anchor in a different row).
    const actionsRow = getByRole('button', { name: 'Complete' }).closest('div')!
    const trigger = actionsRow.querySelector('button[aria-haspopup="menu"]')!
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })

    const item = getByRole('menuitem', { name: /Resume on Spotify \(~27:00\)/ })
    expect(item.tagName).toBe('A')
    expect(item.getAttribute('href')).toBe('https://open.spotify.com/episode/abc123?t=1620')
  })

  it('hides the action when the episode duration is unknown', () => {
    const { getAllByRole, queryByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({ ...dualSourceOverrides(2), title: 'Second Item', queuePosition: 2, durationSeconds: null }),
    ])

    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    expect(queryByRole('menuitem', { name: /Resume on Spotify/ })).toBeNull()
  })

  it('hides the action when Spotify is at the read position (native resume wins)', () => {
    const overrides = dualSourceOverrides(2)
    const { getAllByRole, queryByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({
        ...overrides,
        title: 'Second Item',
        queuePosition: 2,
        sources: overrides.sources!.map((s) =>
          s.platform === 'Spotify' ? { ...s, progress: 45 } : s
        ),
      }),
    ])

    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    expect(queryByRole('menuitem', { name: /Resume on Spotify/ })).toBeNull()
  })
})

describe('Distinguishing multiple Spotify sources in source menus (#245)', () => {
  const spotifyHuman = {
    id: 20,
    platform: 'Spotify',
    link: 'https://open.spotify.com/episode/human',
    messageId: null,
    isPrimary: false,
    createdAt: '2026-01-01T00:00:00Z',
    sourceLabel: 'Astral Codex Ten',
  }
  const spotifyAi = {
    id: 21,
    platform: 'Spotify',
    link: 'https://open.spotify.com/episode/ai',
    messageId: null,
    isPrimary: false,
    createdAt: '2026-01-01T00:00:00Z',
    sourceLabel: 'AI Article Readings',
  }

  it('labels two Spotify sources with their show names in the card menu', () => {
    const { getAllByRole, getByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({
        id: 2,
        title: 'Dual-Spotify Card',
        queuePosition: 2,
        sources: [
          { id: 19, platform: 'Substack', link: 'https://pub.substack.com/p/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
          spotifyHuman,
          spotifyAi,
        ],
      }),
    ])
    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    const menu = within(getByRole('menu'))
    // Each Spotify row is now individually addressable by its show name.
    const human = menu.getByRole('menuitem', { name: /Open on Spotify.*Astral Codex Ten/ })
    const ai = menu.getByRole('menuitem', { name: /Open on Spotify.*AI Article Readings/ })
    expect(human.getAttribute('href')).toBe('https://open.spotify.com/episode/human')
    expect(ai.getAttribute('href')).toBe('https://open.spotify.com/episode/ai')
    // The show name is visible text, not only an accessible-name detail.
    expect(menu.getByText('Astral Codex Ten')).toBeTruthy()
    expect(menu.getByText('AI Article Readings')).toBeTruthy()
  })

  it('leaves a single Spotify source unlabeled in the card menu', () => {
    const { getAllByRole, getByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({
        id: 2,
        title: 'Single-Spotify Card',
        queuePosition: 2,
        sources: [
          { id: 19, platform: 'Substack', link: 'https://pub.substack.com/p/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
          spotifyHuman,
        ],
      }),
    ])
    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    const menu = within(getByRole('menu'))
    // No same-platform sibling → clean "Open on Spotify", the show name suppressed
    // even though the row carries a sourceLabel.
    expect(menu.getByRole('menuitem', { name: 'Open on Spotify' })).toBeTruthy()
    expect(menu.queryByText('Astral Codex Ten')).toBeNull()
  })

  it('disambiguates the hero alternate when the primary is also Spotify (repeats over all sources)', () => {
    // primary=Spotify + one Spotify alternate: computing repeats from the
    // alternate list alone would see a single Spotify and skip the label, while
    // the START button reads "ON SPOTIFY". Repeats must be computed over the
    // item's full source list.
    const { getByRole } = renderList(
      [
        makeItem({
          id: 1,
          title: 'Top Item',
          queuePosition: 1,
          sources: [
            { ...spotifyHuman, isPrimary: true },
            spotifyAi,
          ],
          platform: 'Spotify',
          link: spotifyHuman.link,
        }),
        makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
      ],
      { mediaCounts: { all: 2, audio: 1, text: 1 } },
    )
    const startRow = getByRole('link', { name: /START|RESUME/ }).closest('div')!
    const altTrigger = startRow.querySelector('button[aria-haspopup="menu"]')!
    fireEvent.pointerDown(altTrigger, { button: 0, ctrlKey: false })

    const alt = getByRole('menuitem', { name: /Open on Spotify.*AI Article Readings/ })
    expect(alt.getAttribute('href')).toBe('https://open.spotify.com/episode/ai')
  })
})

describe('Open in Apple Podcasts for Askwho Casts sources (#236)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
  const AWC_MP3 = 'https://app.askwhocasts.com/f/notasecret/media/x.mp3'
  const LIBRARY = 'https://podcasts.apple.com/library'

  const awcSource = {
    id: 9,
    platform: 'Askwho Casts',
    link: AWC_MP3,
    messageId: null,
    isPrimary: false,
    createdAt: '2026-01-01T00:00:00Z',
    sourceLabel: null,
  }

  function stubIphone() {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5 })
  }

  it('swaps the list-card menu entry to an Apple Podcasts anchor on iOS', () => {
    stubIphone()
    const { getAllByRole, getByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({
        id: 2,
        title: 'AWC Item',
        queuePosition: 2,
        sources: [
          { id: 8, platform: 'Substack', link: 'https://pub.substack.com/p/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
          awcSource,
        ],
      }),
    ])

    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    const item = getByRole('menuitem', { name: /Open in Apple Podcasts/ })
    expect(item.tagName).toBe('A')
    expect(item.getAttribute('href')).toBe(LIBRARY)
    expect(screen.queryByRole('menuitem', { name: /Open on Askwho Casts/ })).toBeNull()
  })

  it('keeps the raw MP3 entry off iOS', () => {
    // Default jsdom navigator is not iOS — no stub needed.
    const { getAllByRole, getByRole } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({
        id: 2,
        title: 'AWC Item',
        queuePosition: 2,
        sources: [
          { id: 8, platform: 'Substack', link: 'https://pub.substack.com/p/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
          awcSource,
        ],
      }),
    ])

    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    const item = getByRole('menuitem', { name: /Open on Askwho Casts/ })
    expect(item.getAttribute('href')).toBe(AWC_MP3)
    expect(screen.queryByRole('menuitem', { name: /Open in Apple Podcasts/ })).toBeNull()
  })

  it('swaps the hero alternate-source entry on iOS and still marks the item started', () => {
    stubIphone()
    const onStartItem = vi.fn()
    const { getByRole } = renderList(
      [
        makeItem({
          id: 1,
          title: 'Top Item',
          queuePosition: 1,
          sources: [
            { id: 1, platform: 'Substack', link: 'https://pub.substack.com/p/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
            awcSource,
          ],
        }),
        makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
      ],
      { onStartItem, mediaCounts: { all: 2, audio: 1, text: 2 } },
    )

    const startRow = getByRole('link', { name: /START|RESUME/ }).closest('div')!
    const altTrigger = startRow.querySelector('button[aria-haspopup="menu"]')!
    fireEvent.pointerDown(altTrigger, { button: 0, ctrlKey: false })

    // #364: the episode is START, so the article moves into the menu.
    expect(startRow.querySelector('a')!.getAttribute('href')).toBe(LIBRARY)
    const item = getByRole('menuitem', { name: /Open on Substack/ })
    expect(item.tagName).toBe('A')

    fireEvent.click(item)
    expect(onStartItem).toHaveBeenCalledTimes(1)
  })

  it('points the hero START anchor at Apple Podcasts when AWC is the only source (iOS)', () => {
    stubIphone()
    const { getByRole } = renderList([
      makeItem({
        id: 1,
        title: 'AWC Only',
        queuePosition: 1,
        sources: [{ ...awcSource, isPrimary: true }],
        platform: 'Askwho Casts',
        link: AWC_MP3,
      }),
      makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
    ])

    const start = getByRole('link', { name: 'START IN APPLE PODCASTS' })
    expect(start.getAttribute('href')).toBe(LIBRARY)
  })

  it('keeps the hero START anchor on the MP3 link off iOS', () => {
    const { getByRole } = renderList([
      makeItem({
        id: 1,
        title: 'AWC Only',
        queuePosition: 1,
        sources: [{ ...awcSource, isPrimary: true }],
        platform: 'Askwho Casts',
        link: AWC_MP3,
      }),
      makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
    ])

    // Single source: no platform suffix, exactly as today.
    const start = getByRole('link', { name: 'START' })
    expect(start.getAttribute('href')).toBe(AWC_MP3)
  })

  it('renders the MP3 href on the server pass and swaps only after hydration (SSR safety)', () => {
    // The page is SSR'd (app/page.tsx is force-dynamic); the first client
    // render must match the server HTML or React logs a hydration mismatch on
    // exactly the platform this feature targets — same discipline as #197.
    stubIphone()
    const items = [
      makeItem({
        id: 1,
        title: 'AWC Only',
        queuePosition: 1,
        sources: [{ ...awcSource, isPrimary: true }],
        platform: 'Askwho Casts',
        link: AWC_MP3,
      }),
      makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
    ]
    const el = <ReadingList items={items} {...baseProps()} />

    // Server pass: hero START still carries the MP3 link; no Library URL.
    const ssrHtml = renderToString(el)
    expect(ssrHtml).not.toContain(LIBRARY)
    expect(ssrHtml).toContain(`href="${AWC_MP3}"`)

    // Hydrated client: the anchor swaps to Apple Podcasts.
    const { getByRole } = render(el)
    expect(getByRole('link', { name: 'START IN APPLE PODCASTS' }).getAttribute('href')).toBe(LIBRARY)
  })
})

describe('ReadingList book covers (#168)', () => {
  function renderBooks(items: QueueItem[]) {
    return renderList(items, {
      mediaCounts: { all: items.length, audio: 0, text: items.length },
      kind: 'book',
    })
  }

  function makeBook(overrides: Partial<QueueItem> = {}): QueueItem {
    return makeItem({
      kind: 'book',
      sources: [
        { id: 1, platform: 'Goodreads', link: 'https://www.goodreads.com/book/show/1', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
      ],
      platform: 'Goodreads',
      link: 'https://www.goodreads.com/book/show/1',
      ...overrides,
    })
  }

  it('renders cover images on the hero and queue book cards when imageUrl is set', () => {
    const { container } = renderBooks([
      makeBook({ id: 1, queuePosition: 1, title: 'Snow Crash', imageUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg' }),
      makeBook({ id: 2, queuePosition: 2, title: 'Seveneves', imageUrl: 'https://covers.openlibrary.org/b/id/2-L.jpg' }),
    ])
    const srcs = Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src'))
    expect(srcs).toContain('https://covers.openlibrary.org/b/id/1-L.jpg') // hero
    expect(srcs).toContain('https://covers.openlibrary.org/b/id/2-L.jpg') // queue card
  })

  it('renders a book-cover placeholder for books without a cover (hero + queue)', () => {
    const { container } = renderBooks([
      makeBook({ id: 1, queuePosition: 1, title: 'No Cover', imageUrl: null }),
      makeBook({ id: 2, queuePosition: 2, title: 'Also None', imageUrl: null }),
    ])
    expect(container.querySelector('img')).toBeNull()
    const placeholders = container.querySelectorAll('[aria-label="Book cover placeholder"]')
    // hero + the queue card both fall back to the BookOpen placeholder
    expect(placeholders.length).toBeGreaterThanOrEqual(2)
  })

  it('shows the promoted book’s cover in the hero even after a prior hero cover failed to load (#168)', () => {
    // Reproduces the reported bug: the hero is the one un-keyed thumbnail slot.
    // Once a hero cover fails to load (e.g. a hot-link-blocked host), the old
    // code latched the placeholder for every later promoted book.
    const a = makeBook({ id: 1, queuePosition: 1, title: 'First', imageUrl: 'https://covers.openlibrary.org/b/id/11-L.jpg' })
    const b = makeBook({ id: 2, queuePosition: 2, title: 'Second', imageUrl: 'https://covers.openlibrary.org/b/id/22-L.jpg' })

    const el = (items: QueueItem[]) => (
      <ReadingList
        items={items}
        {...baseProps()}
        mediaCounts={{ all: items.length, audio: 0, text: items.length }}
        kind="book"
      />
    )

    const { container, rerender } = render(el([a, b]))
    // Hero is A; simulate its cover failing to load.
    const heroImg = container.querySelector('img')!
    expect(heroImg.getAttribute('src')).toBe('https://covers.openlibrary.org/b/id/11-L.jpg')
    fireEvent.error(heroImg)

    // Promote B to the top, exactly as make-next reorders the array.
    rerender(el([{ ...b, queuePosition: 1 }, { ...a, queuePosition: 2 }]))

    const srcs = Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src'))
    expect(srcs).toContain('https://covers.openlibrary.org/b/id/22-L.jpg')
  })
})

describe('ReadingList filter controls (#241)', () => {
  const twoItems = () => [
    makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
    makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
  ]

  it('renders the Filters trigger first in the toolbar', () => {
    const { getByRole, getByTitle } = renderList(twoItems())
    const trigger = getByRole('button', { name: /^Filters/ })
    const addButton = getByTitle('Add entry')
    const heroTitle = getByRole('heading', { level: 1 })

    // Trigger leads the toolbar, and the whole toolbar precedes the hero title.
    expect(trigger.compareDocumentPosition(addButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(addButton.compareDocumentPosition(heroTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens the filter sheet from the toolbar and routes media clicks', () => {
    const onMediaFilterChange = vi.fn()
    const view = renderList(twoItems(), { onMediaFilterChange })
    fireEvent.click(view.getByRole('button', { name: /^Filters/ }))
    fireEvent.click(view.getByRole('button', { name: 'Text (2)' }))
    expect(onMediaFilterChange).toHaveBeenCalledWith('text')
  })

  it('marks the trigger active and shows the badge when filters apply', () => {
    const view = renderList(twoItems(), { mediaFilter: 'text' })
    const trigger = view.getByRole('button', { name: /^Filters/ })
    expect(trigger.getAttribute('data-filters-active')).toBe('true')
    expect(trigger.textContent).toBe('1')
  })

  it('marks the trigger inactive with no filters applied', () => {
    const view = renderList(twoItems())
    const trigger = view.getByRole('button', { name: /^Filters/ })
    expect(trigger.getAttribute('data-filters-active')).toBe('false')
  })

  it('shows summary chips for active filters on the main screen', () => {
    const onSelectedAuthorsChange = vi.fn()
    const view = renderList(twoItems(), {
      authorOptions: [{ key: 'jane doe', label: 'Jane Doe', count: 2 }],
      selectedAuthors: ['Jane Doe'],
      onSelectedAuthorsChange,
    })
    fireEvent.click(view.getByRole('button', { name: 'Remove filter Jane Doe' }))
    expect(onSelectedAuthorsChange).toHaveBeenCalledWith([])
  })

  it('keeps the filter controls reachable on the empty state', () => {
    const view = renderList([], { mediaFilter: 'audio' })
    expect(view.getByText('No matching items')).toBeTruthy()
    // Both escape hatches render: the sheet trigger and the summary chips.
    expect(view.getByRole('button', { name: /^Filters/ })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Remove filter Audio' })).toBeTruthy()
  })

  it('renders the settings gear as a direct link to the first settings page', () => {
    // The settings subpages have their own cross-nav, so the gear goes
    // straight there instead of opening a redundant dropdown.
    const { getByRole, queryByRole } = renderList(twoItems())
    const gear = getByRole('link', { name: 'Settings' })
    expect(gear.getAttribute('href')).toBe('/settings/feeds')
    expect(queryByRole('button', { name: 'Settings' })).toBeNull()
  })

  it('shows filter-specific empty copy when active filters match nothing', () => {
    // With filters active, "All caught up! / Your queue is empty" would be a
    // lie — the queue has items, the filter just excludes them all.
    const { getByText, queryByText } = renderList([], {
      authorOptions: [{ key: 'jane doe', label: 'Jane Doe', count: 0 }],
      selectedAuthors: ['Jane Doe'],
    })
    expect(getByText('No matching items')).toBeTruthy()
    expect(queryByText('All caught up!')).toBeNull()
  })
})

describe('Convert with Askwho Casts (#226)', () => {
  const twoItems = () => [
    makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
    makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
  ]

  it('shows the convert action for a text item when onConvert is provided', async () => {
    const onConvert = vi.fn().mockResolvedValue(undefined)
    const { getAllByRole, getByText } = renderList(twoItems(), { onConvert })

    // Menu triggers in DOM order: header sort, hero ⋯, list-card ⋯ — the
    // list card's trigger is the last one (same convention as the #197 tests).
    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    expect(await screen.findByText('Convert with Askwho Casts')).toBeTruthy()
    fireEvent.click(getByText('Convert with Askwho Casts'))
    expect(onConvert).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
  })

  it('hides the convert action for items with a native audio source', async () => {
    const onConvert = vi.fn().mockResolvedValue(undefined)
    const { getAllByRole, queryByText } = renderList(
      [
        makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
        makeItem({
          id: 2,
          title: 'Second Item',
          queuePosition: 2,
          sources: [
            { id: 2, platform: 'Spotify', link: 'https://open.spotify.com/episode/y', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
          ],
          platform: 'Spotify',
          link: 'https://open.spotify.com/episode/y',
        }),
      ],
      { onConvert, mediaCounts: { all: 2, audio: 1, text: 1 } },
    )

    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    expect(queryByText('Convert with Askwho Casts')).toBeNull()
  })

  it('hides the convert action when onConvert is not passed (books client)', async () => {
    const { getAllByRole, queryByText } = renderList(twoItems())

    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })

    expect(queryByText('Convert with Askwho Casts')).toBeNull()
  })
})

describe('ReadingList drag reorder guard with filters (#202, #227)', () => {
  const twoItems = () => [
    makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
    makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
  ]

  it('shows the drag handle in queue sort with no filters active', () => {
    const { container } = renderList(twoItems())
    expect(container.querySelector('.cursor-grab')).not.toBeNull()
  })

  it('hides the drag handle while an author filter is active', () => {
    // Reordering a filtered subset would silently corrupt positions of the
    // hidden items — same guard the media filter already has.
    const { container } = renderList(twoItems(), {
      authorOptions: [{ key: 'jane doe', label: 'Jane Doe', count: 2 }],
      selectedAuthors: ['Jane Doe'],
    })
    expect(container.querySelector('.cursor-grab')).toBeNull()
  })

  it('hides the drag handle while a read-state filter is active', () => {
    const { container } = renderList(twoItems(), {
      readStateOptions: [{ key: 'confirmed', label: 'Confirmed', count: 2 }],
      selectedReadStates: ['confirmed'],
    })
    expect(container.querySelector('.cursor-grab')).toBeNull()
  })
})

describe('Recommended sort option (#255)', () => {
  const twoItems = () => [
    makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
    makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
  ]

  it('offers Recommended in the sort menu and reports the change', () => {
    const onSortChange = vi.fn()
    const { getAllByRole, getByRole } = renderList(twoItems(), { onSortChange })

    // Header sort menu is the FIRST menu trigger in DOM order (same
    // convention as the #197/#226 tests, from the other end).
    const triggers = getAllByRole('button').filter(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    )
    fireEvent.pointerDown(triggers[0], { button: 0, ctrlKey: false })

    const item = getByRole('menuitem', { name: /Recommended/ })
    fireEvent.click(item)
    expect(onSortChange).toHaveBeenCalledWith('recommended')
  })

  it('shows FOR YOU on the trigger while recommended sort is active', () => {
    const { getByText } = renderList(twoItems(), { sortDirection: 'recommended' })
    expect(getByText('FOR YOU')).toBeTruthy()
  })

  it('hides the drag handle in recommended sort', () => {
    const { container } = renderList(twoItems(), { sortDirection: 'recommended' })
    expect(container.querySelector('.cursor-grab')).toBeNull()
  })

  // Recommended pins the position-1 item as hero like newest/oldest, so a
  // make-next tap visibly promotes the card there too — no gating needed.
  it('fires make-next when tapping a card in recommended sort', () => {
    const onMakeNext = vi.fn().mockResolvedValue(undefined)
    const { getByText } = renderList(twoItems(), {
      sortDirection: 'recommended',
      onMakeNext,
    })

    fireEvent.click(getByText('Second Item'))
    expect(onMakeNext).toHaveBeenCalledTimes(1)
  })

  it('fires make-next when tapping a card in queue sort', () => {
    const onMakeNext = vi.fn().mockResolvedValue(undefined)
    const { getByText } = renderList(twoItems(), { onMakeNext })

    fireEvent.click(getByText('Second Item'))
    expect(onMakeNext).toHaveBeenCalledTimes(1)
  })
})

describe('Awaiting comments (#266)', () => {
  const pending = (id: number) => makeItem({
    id, title: `Pending ${id}`, queuePosition: id, status: 'Awaiting comments', progress: '96',
    sources: [
      { id: 10 + id, platform: 'Spotify', link: 'https://open.spotify.com/episode/test', messageId: null, isPrimary: true, createdAt: '', sourceLabel: null },
      { id: 20 + id, platform: 'LessWrong', link: 'https://www.lesswrong.com/posts/test/title?foo=bar#old', messageId: null, isPrimary: false, createdAt: '', sourceLabel: null },
    ],
  })
  it('renders reminders and working Done actions on featured and smaller cards', () => {
    const done = vi.fn()
    const start = vi.fn()
    const items = [pending(1), pending(2)]
    renderList(items, { onMarkComplete: done, onStartItem: start })
    expect(screen.getAllByText('Finished listening — have you read the comments?')).toHaveLength(2)
    expect(screen.getAllByText('Awaiting comments')).toHaveLength(2)
    const links = screen.getAllByRole('link', { name: 'Open comments' })
    expect(links).toHaveLength(2)
    for (const link of links) expect(link.getAttribute('href')).toContain('/posts/test/title?foo=bar#comments')
    fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[1])
    expect(done).toHaveBeenCalledWith(items[1])
    expect(start).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /RESUME/ })).toBeTruthy()
  })
  it('keeps Done available when the post URL is missing', () => {
    renderList([{ ...pending(1), sources: [] }])
    expect(screen.queryByRole('link', { name: 'Open comments' })).toBeNull()
    expect(screen.getByText('Comments link unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
  })
  it('does not show reminders for ordinary in-progress cards', () => {
    renderList([makeItem({ status: 'In Progress' })])
    expect(screen.queryByText('Finished listening — have you read the comments?')).toBeNull()
  })
})

describe('Search field (#283)', () => {
  const twoItems = () => [
    makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
    makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
  ]

  it('renders the search field under the toolbar and reports typing', () => {
    const onSearchQueryChange = vi.fn()
    const view = renderList(twoItems(), { onSearchQueryChange })
    const input = view.getByRole('searchbox', { name: 'Search by title or author' })
    fireEvent.change(input, { target: { value: 'top' } })
    expect(onSearchQueryChange).toHaveBeenCalledWith('top')
  })

  it('uses a kind-specific placeholder', () => {
    const feed = renderList(twoItems())
    expect((feed.getByRole('searchbox') as HTMLInputElement).placeholder).toBe('Search queue')
    feed.unmount()
    const books = renderList(twoItems(), { kind: 'book' })
    expect((books.getByRole('searchbox') as HTMLInputElement).placeholder).toBe('Search books')
  })

  it('does not count the search toward the filter badge or chips', () => {
    const view = renderList(twoItems(), { searchQuery: 'top' })
    expect(view.getByRole('button', { name: /^Filters/ }).getAttribute('data-filters-active')).toBe('false')
    expect(view.queryByRole('button', { name: /^Remove filter/ })).toBeNull()
  })

  it('shows a search-specific empty state with a Clear search action', () => {
    const onSearchQueryChange = vi.fn()
    const view = renderList([], { searchQuery: 'zzz', onSearchQueryChange })
    expect(view.getByText('No items match "zzz"')).toBeTruthy()
    expect(view.getByText('Try a different search, or clear it to see your queue.')).toBeTruthy()
    expect(view.queryByText('All caught up!')).toBeNull()
    // The field itself stays reachable on the empty state.
    expect(view.getByRole('searchbox')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Clear search and show all items' }))
    expect(onSearchQueryChange).toHaveBeenCalledWith('')
  })

  it('keeps the generic filter empty copy when only sheet filters are active', () => {
    const view = renderList([], { mediaFilter: 'audio' })
    expect(view.getByText('No matching items')).toBeTruthy()
  })

  it('names both causes when a search AND a sheet filter empty the list', () => {
    // Clearing only the search might still leave an empty (Audio-filtered)
    // list, so the copy must not promise that clearing the search fixes it.
    const view = renderList([], { searchQuery: 'bitter', mediaFilter: 'audio' })
    expect(view.getByText('No matching items')).toBeTruthy()
    expect(view.getByText('Clear the search or adjust the filters to see your queue.')).toBeTruthy()
    expect(view.queryByText('No items match "bitter"')).toBeNull()
    expect(view.queryByRole('button', { name: 'Clear search and show all items' })).toBeNull()
  })

  it('says "books", not "queue", in the books empty-state copy', () => {
    const searchOnly = renderList([], { searchQuery: 'zzz', kind: 'book' })
    expect(searchOnly.getByText('Try a different search, or clear it to see your books.')).toBeTruthy()
    searchOnly.unmount()
    const combined = renderList([], { searchQuery: 'zzz', mediaFilter: 'audio', kind: 'book' })
    expect(combined.getByText('Clear the search or adjust the filters to see your books.')).toBeTruthy()
    combined.unmount()
    const filterOnly = renderList([], { mediaFilter: 'audio', kind: 'book' })
    expect(filterOnly.getByText('Adjust or clear the filters to see your books.')).toBeTruthy()
  })
})

describe('inline summary one-liner (#304)', () => {
  const data = (oneLiner: string) => ({
    oneLiner, bullets: ['a', 'b', 'c', 'd'], sourceAccess: 'full_text' as const, model: 'claude-opus-5-5',
  })

  it('shows the one-liner on the hero and on list cards', () => {
    renderList([
      makeItem({ id: 1, title: 'Hero', summary: 'Hero claim.', summaryData: data('Hero claim.') }),
      makeItem({ id: 2, title: 'Second', queuePosition: 2, summary: 'Second claim.', summaryData: data('Second claim.') }),
    ])
    expect(screen.getByText('Hero claim.')).toBeDefined()
    expect(screen.getByText('Second claim.')).toBeDefined()
  })

  it('never shows a legacy paragraph inline', () => {
    const legacy = 'This is Scott Alexander\'s essay responding to a book review that became a finalist...'
    renderList([makeItem({ id: 1, summary: legacy, summaryData: null })])
    expect(screen.queryByText(legacy)).toBeNull()
    expect(screen.queryByTestId('summary-one-liner')).toBeNull()
  })

  it('never shows the one-liner for books', () => {
    renderList(
      [makeItem({ id: 1, kind: 'book', summary: 'Book claim.', summaryData: data('Book claim.') })],
      { kind: 'book' },
    )
    expect(screen.queryByTestId('summary-one-liner')).toBeNull()
  })

  it('clamps the one-liner while scanning and shows it in full once its panel is open', () => {
    renderList([
      makeItem({ id: 1, title: 'Hero', summary: 'Hero claim.', summaryData: data('Hero claim.') }),
      makeItem({ id: 2, title: 'Second', queuePosition: 2, summary: 'Second claim.', summaryData: data('Second claim.') }),
    ])
    const hero = screen.getByText('Hero claim.')
    const second = screen.getByText('Second claim.')
    expect(hero.className).toContain('line-clamp-2')
    expect(second.className).toContain('line-clamp-2')

    for (const toggle of screen.getAllByTitle('Show AI Summary')) fireEvent.click(toggle)
    expect(screen.getByText('Hero claim.').className).not.toContain('line-clamp')
    expect(screen.getByText('Second claim.').className).not.toContain('line-clamp')
  })

  it('shows the one-liner right after Generate, without a reload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ summary: 'Fresh claim.', summaryData: data('Fresh claim.'), generatedAt: '2026-09-27T00:00:00Z' }),
    }))
    renderList([makeItem({ id: 1, summary: null, summaryData: null })])
    fireEvent.click(screen.getAllByTitle('Show AI Summary')[0])
    fireEvent.click(screen.getByText('Generate Summary'))
    expect(await screen.findByTestId('summary-one-liner')).toHaveProperty('textContent', 'Fresh claim.')
    vi.unstubAllGlobals()
  })
})

describe('ReadingList desktop layout (#303)', () => {
  const twoItems = () => [
    makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
    makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
  ]

  it('keeps the mobile column width and widens only at lg', () => {
    const { container } = renderList(twoItems())
    const root = container.firstElementChild as HTMLElement
    expect(root.classList.contains('max-w-md')).toBe(true)
    expect(root.classList.contains('lg:max-w-6xl')).toBe(true)
  })

  it('puts search and toolbar on one row at lg, search stretching', () => {
    const { getByRole } = renderList(twoItems())
    const searchWrap = getByRole('searchbox').parentElement as HTMLElement
    expect(searchWrap.classList.contains('mb-2')).toBe(true)
    expect(searchWrap.classList.contains('lg:flex-1')).toBe(true)
    const headerRow = searchWrap.parentElement as HTMLElement
    expect(headerRow.classList.contains('lg:flex')).toBe(true)
  })

  it('applies the same header row in the empty state', () => {
    const { getByRole, container } = renderList([])
    const root = container.firstElementChild as HTMLElement
    expect(root.classList.contains('lg:max-w-6xl')).toBe(true)
    const headerRow = getByRole('searchbox').parentElement!.parentElement as HTMLElement
    expect(headerRow.classList.contains('lg:flex')).toBe(true)
  })

  it('wraps the hero in a sticky rail beside the queue list at lg', () => {
    const { getByRole, getByText } = renderList(twoItems())
    const rail = getByRole('region', { name: 'Current item' })
    expect(rail.contains(getByRole('heading', { level: 1, name: 'Top Item' }))).toBe(true)
    expect(rail.contains(getByRole('button', { name: 'Complete' }))).toBe(true)
    for (const c of ['lg:sticky', 'lg:top-4', 'lg:overflow-y-auto']) {
      expect(rail.classList.contains(c)).toBe(true)
    }
    // overflow-y:auto forces overflow-x to auto too, so the rail needs an
    // inner gutter (net-zero via -mx) for edge buttons' 3px focus rings, and
    // the title must wrap long unbroken tokens instead of scrolling sideways.
    for (const c of ['lg:-mx-1', 'lg:px-1', 'lg:pb-1']) {
      expect(rail.classList.contains(c)).toBe(true)
    }
    expect(getByRole('heading', { level: 1, name: 'Top Item' }).classList.contains('lg:wrap-anywhere')).toBe(true)
    const grid = rail.parentElement as HTMLElement
    expect(grid.classList.contains('lg:grid')).toBe(true)
    expect(grid.classList.contains('lg:grid-cols-[340px_minmax(0,1fr)]')).toBe(true)
    // The list lives in the grid's second column, outside the rail.
    const listCard = getByText('Second Item')
    expect(rail.contains(listCard)).toBe(false)
    expect(grid.contains(listCard)).toBe(true)
  })

  // Desktop card grid: [thumb | title + author] on top, then the one-liner /
  // progress full-width from the card's left edge, then chips (and
  // Confirm/Skip, right-aligned) always on the bottom row — chips never jump
  // up beside the title when there happens to be horizontal room. The lower
  // rows are auto-placed so an empty summary row leaves no extra gap.
  const GRID = ['lg:grid', 'lg:grid-cols-[auto_minmax(0,1fr)_auto]']
  const hasAll = (el: Element, classes: string[]) =>
    classes.every(c => el.classList.contains(c))

  it('lays a queue card out as a two-row grid at lg, keeping mobile classes', () => {
    const { container, getByText, getAllByTitle } = renderList(twoItems())
    const grip = container.querySelector('[aria-roledescription="sortable"]') as HTMLElement
    expect(grip).toBeTruthy()
    // Mobile: absolutely positioned grip. Desktop: last flex item, centered.
    expect(grip.classList.contains('absolute')).toBe(true)
    expect(hasAll(grip, ['lg:static', 'lg:translate-y-0', 'lg:order-last'])).toBe(true)
    expect((grip.parentElement as HTMLElement).classList.contains('lg:flex')).toBe(true)
    const body = grip.nextElementSibling as HTMLElement
    expect(hasAll(body, [...GRID, 'lg:flex-1', 'lg:min-w-0'])).toBe(true)
    const thumb = body.firstElementChild as HTMLElement
    expect(thumb.classList.contains('float-right')).toBe(true)
    expect(hasAll(thumb, ['lg:row-start-1', 'lg:col-start-1'])).toBe(true)
    // Title column spans to the card's right edge; no min-width floor needed.
    const title = getByText('Second Item')
    const textCol = title.closest('.lg\\:col-start-2') as HTMLElement
    expect(textCol.parentElement).toBe(body)
    expect(hasAll(textCol, ['lg:row-start-1', 'lg:col-span-2'])).toBe(true)
    expect(textCol.classList.contains('lg:min-w-56')).toBe(false)
    expect(textCol.textContent).toContain('Test Author')
    expect(title.classList.contains('lg:text-base')).toBe(true)
    // Chips: always bottom row, from the card's left edge under the thumbnail.
    const sparkle = getAllByTitle('Show AI Summary').find(b => body.contains(b))!
    const chips = sparkle.parentElement as HTMLElement
    expect(chips.parentElement).toBe(body)
    expect(hasAll(chips, ['flex-wrap', 'lg:col-start-1', 'lg:col-span-2'])).toBe(true)
    expect(chips.classList.contains('lg:row-start-2')).toBe(false)
    expect(chips.classList.contains('lg:flex-nowrap')).toBe(false)
    expect(body.lastElementChild).toBe(chips)
  })

  it('puts the one-liner and progress full-width below the thumbnail row at lg', () => {
    const { getByText } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({
        id: 2, title: 'Second Item', queuePosition: 2, summary: 'Claim.', progress: '40',
        summaryData: { oneLiner: 'Claim.', bullets: ['a'], sourceAccess: 'full_text', model: 'm' },
      }),
    ])
    const textCol = getByText('Second Item').closest('.lg\\:col-start-2') as HTMLElement
    const oneLiner = getByText('Claim.')
    // Title, author and badges stay indented beside the thumbnail…
    expect(textCol.textContent).toContain('Test Author')
    expect(textCol.contains(oneLiner)).toBe(false)
    // …while the one-liner and progress span the card from its left edge.
    const below = oneLiner.parentElement as HTMLElement
    expect(below.parentElement).toBe(textCol.parentElement)
    expect(hasAll(below, ['lg:col-span-3', 'lg:empty:hidden'])).toBe(true)
    expect(below.classList.contains('lg:row-start-2')).toBe(false)
    expect(below.textContent).toContain('40% complete')
  })

  it('drops the one-liner grip padding at lg', () => {
    const { getByText } = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({
        id: 2, title: 'Second Item', queuePosition: 2, summary: 'Claim.',
        summaryData: { oneLiner: 'Claim.', bullets: ['a'], sourceAccess: 'full_text', model: 'm' },
      }),
    ])
    const oneLiner = getByText('Claim.')
    expect(hasAll(oneLiner, ['pr-10', 'lg:pr-0'])).toBe(true)
  })

  it('keeps the grid when filters hide the grip', () => {
    const { container, getByText } = renderList(twoItems(), { selectedAuthors: ['Test Author'] })
    expect(container.querySelector('[aria-roledescription="sortable"]')).toBeNull()
    const body = getByText('Second Item').closest('.lg\\:grid') as HTMLElement
    expect(body).toBeTruthy()
    expect(hasAll(body, GRID)).toBe(true)
  })

  it('renders the drag overlay card with the same grid at lg', () => {
    const item = transformToDisplayItem(makeItem({
      id: 2, title: 'Dragged', summary: 'Gist.',
      summaryData: { oneLiner: 'Gist.', bullets: ['a'], sourceAccess: 'full_text', model: 'm' },
    }))
    const { container, getByText } = render(
      <QueueItemCard item={item} formatDate={() => ''} />,
    )
    const card = container.firstElementChild as HTMLElement
    expect(card.classList.contains('lg:flex')).toBe(true)
    const grip = container.querySelector('.lucide-grip-vertical')!.parentElement as HTMLElement
    expect(hasAll(grip, ['absolute', 'lg:static', 'lg:order-last'])).toBe(true)
    const body = grip.nextElementSibling as HTMLElement
    expect(hasAll(body, ['pr-8', 'lg:pr-0', ...GRID])).toBe(true)
    const textCol = getByText('Dragged').closest('.lg\\:col-start-2') as HTMLElement
    expect(textCol.parentElement).toBe(body)
    expect(textCol.contains(getByText('Gist.'))).toBe(false)
    expect(hasAll(getByText('Gist.').parentElement as HTMLElement, ['lg:col-span-3', 'lg:empty:hidden'])).toBe(true)
    expect(hasAll(body.lastElementChild as HTMLElement, ['lg:col-start-1', 'lg:col-span-2'])).toBe(true)
  })
})

describe('Convert comments with Askwho Casts (#368)', () => {
  const lw = { id: 11, platform: 'LessWrong', link: 'https://www.lesswrong.com/posts/abc/title', messageId: null, isPrimary: true, createdAt: 'c', sourceLabel: null }
  const articleEpisode = { id: 12, platform: 'Askwho Casts', link: 'https://app.askwhocasts.com/f/s/media/a.mp3', messageId: null, isPrimary: false, createdAt: 'c', sourceLabel: null }
  const commentsEpisode = { ...articleEpisode, id: 13, link: 'https://app.askwhocasts.com/f/s/media/c.mp3', sourceLabel: 'Comments' }
  const conv = (status: string, kind: 'article' | 'comments', error: string | null = null) =>
    ({ id: 9, kind, status, error, requestedAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z' }) as QueueItem['awcConversion']
  const items = (over: Partial<QueueItem> = {}) => [
    makeItem({ id: 1, title: 'Top', queuePosition: 1 }),
    makeItem({ id: 2, title: 'Post', queuePosition: 2, sources: [lw], ...over }),
  ]
  const openCardMenu = async (view: ReturnType<typeof renderList>) => {
    const triggers = view.getAllByRole('button').filter((b) => b.getAttribute('aria-haspopup') === 'menu')
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })
    await screen.findAllByRole('menuitem')
  }

  it('offers it on a LessWrong card and sends the comments kind', async () => {
    const onConvert = vi.fn().mockResolvedValue(undefined)
    await openCardMenu(renderList(items(), { onConvert }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert comments with Askwho Casts' }))
    expect(onConvert).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 'comments')
  })
  it('offers it in the hero menu too', async () => {
    const view = renderList([makeItem({ id: 2, title: 'Post', queuePosition: 1, sources: [lw] })], { onConvert: vi.fn() })
    await openCardMenu(view)
    expect(screen.getByRole('menuitem', { name: 'Convert comments with Askwho Casts' })).toBeTruthy()
  })
  it('does not offer it on other cards', async () => {
    await openCardMenu(renderList(items({ sources: [{ ...lw, platform: 'Substack', link: 'https://ex.com/p' }] }), { onConvert: vi.fn() }))
    expect(screen.queryByRole('menuitem', { name: /Convert comments/ })).toBeNull()
  })
  it('disables both options while either kind is converting', async () => {
    await openCardMenu(renderList(items({ awcConversion: conv('generating', 'article') }), { onConvert: vi.fn() }))
    expect(screen.getByRole('menuitem', { name: 'Converting…' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitem', { name: 'Convert comments with Askwho Casts' }).getAttribute('aria-disabled')).toBe('true')
  })
  it('shows its own stage while comments are converting', async () => {
    await openCardMenu(renderList(items({ awcConversion: conv('generating', 'comments') }), { onConvert: vi.fn() }))
    expect(screen.getByRole('menuitem', { name: 'Converting comments…' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitem', { name: 'Convert with Askwho Casts' }).getAttribute('aria-disabled')).toBe('true')
  })
  it('retries only the failed kind, with no manual fallback for comments', async () => {
    const onConvert = vi.fn().mockResolvedValue(undefined)
    await openCardMenu(renderList(items({ awcConversion: conv('failed', 'comments', 'too few comments yet') }), { onConvert, onConvertManually: vi.fn() }))
    expect(screen.getByRole('menuitem', { name: 'Retry comments with Askwho Casts' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Convert with Askwho Casts' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Retry Askwho Casts/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /manually/ })).toBeNull()
  })
  it('hides it once the post has its comments episode, keeping article Convert', async () => {
    await openCardMenu(renderList(items({ sources: [lw, commentsEpisode] }), { onConvert: vi.fn() }))
    expect(screen.queryByRole('menuitem', { name: /Convert comments/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Convert with Askwho Casts' })).toBeTruthy()
  })
  it('shows a comments conversion on a post that already has an article episode', () => {
    const view = renderList(items({ sources: [lw, articleEpisode], awcConversion: conv('generating', 'comments') }), { onConvert: vi.fn() })
    expect(view.getByText('Comments: Recording')).toBeTruthy()
  })
  it('still hides an article badge once the article episode exists', () => {
    const view = renderList(items({ sources: [lw, articleEpisode], awcConversion: conv('failed', 'article', 'timeout') }), { onConvert: vi.fn() })
    expect(view.queryByText('Failed')).toBeNull()
  })
})

describe('Askwho Casts agent conversion (#317)', () => {
  const conv = (status: string, error: string | null = null) =>
    ({ id: 9, status, error, requestedAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z' }) as QueueItem['awcConversion']
  const openListMenu = (getAllByRole: (r: string) => HTMLElement[]) => {
    const triggers = getAllByRole('button').filter((b) => b.getAttribute('aria-haspopup') === 'menu')
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })
  }

  it('shows the stage pill on a list card', () => {
    renderList([makeItem({ id: 1 }), makeItem({ id: 2, queuePosition: 2, awcConversion: conv('building_script') })], { onConvert: noop })
    expect(screen.getByText('Writing script')).toBeTruthy()
  })
  it('shows the stage pill on the hero card', () => {
    renderList([makeItem({ id: 1, awcConversion: conv('generating') })], { onConvert: noop })
    expect(screen.getByText('Recording')).toBeTruthy()
  })
  it('shows Mac offline when the agent heartbeat is stale', () => {
    renderList([makeItem({ id: 1, awcConversion: conv('queued') })], {
      onConvert: noop, awcAgent: { stale: true, checkedAt: Date.parse('2026-10-04T12:05:00Z') },
    })
    expect(screen.getByText('Queued · Mac offline')).toBeTruthy()
  })
  it('disables the convert item while converting', () => {
    const { getAllByRole } = renderList([makeItem({ id: 1 }), makeItem({ id: 2, queuePosition: 2, awcConversion: conv('starting') })], { onConvert: noop })
    openListMenu(getAllByRole)
    expect(screen.getByRole('menuitem', { name: /Converting…/ }).getAttribute('data-disabled')).not.toBeNull()
  })
  it('offers Retry and the manual fallback after a failure', () => {
    const onConvert = vi.fn(async () => {})
    const onConvertManually = vi.fn(async () => {})
    const { getAllByRole } = renderList(
      [makeItem({ id: 1 }), makeItem({ id: 2, queuePosition: 2, awcConversion: conv('failed', 'timeout') })],
      { onConvert, onConvertManually },
    )
    expect(screen.getByText('Failed')).toBeTruthy()
    openListMenu(getAllByRole)
    fireEvent.click(screen.getByRole('menuitem', { name: /Retry Askwho Casts/ }))
    expect(onConvert).toHaveBeenCalled()
    openListMenu(getAllByRole)
    fireEvent.click(screen.getByRole('menuitem', { name: /Open Askwho Casts manually/ }))
    expect(onConvertManually).toHaveBeenCalled()
  })
  // #363: the warning must survive the episode attaching, which makes the item
  // audio and hides every other conversion pill.
  describe('short episode pill', () => {
    const warning = 'short episode: 5 credits for about 3,542 words'
    const withEpisode = {
      sources: [
        { id: 1, platform: 'Substack', link: 'https://example.com/a', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
        { id: 2, platform: 'Askwho Casts', link: 'https://app.askwhocasts.com/f/x/media/y.mp3', messageId: null, isPrimary: false, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
      ],
    } as Partial<QueueItem>
    it('shows on an item whose episode has attached, with the reason as a tooltip', () => {
      renderList([makeItem({ id: 1, ...withEpisode, awcConversion: conv('done', warning) })], { onConvert: noop })
      expect(screen.getByText('Short episode').closest('span')?.getAttribute('title')).toBe(warning)
    })
    it('does not bring back a Failed pill on an item that has audio', () => {
      renderList([makeItem({ id: 1, ...withEpisode, awcConversion: conv('failed', 'agent timed out') })], { onConvert: noop })
      expect(screen.queryByText('Failed')).toBeNull()
    })
    it('does not spin', () => {
      renderList([makeItem({ id: 1, awcConversion: conv('generating', warning) })], { onConvert: noop })
      expect(screen.getByText('Short episode').closest('span')?.querySelector('.animate-spin')).toBeNull()
    })
  })

  // #364: Convert upgrades weak audio, so Spotify no longer hides it or the pill.
  describe('on posts that already have audio', () => {
    const src = (id: number, platform: string, link: string, isPrimary = false, sourceLabel: string | null = null) =>
      ({ id, platform, link, messageId: null, isPrimary, createdAt: 'c', sourceLabel })
    const spotify = src(1, 'Spotify', 'https://open.spotify.com/episode/x', true)
    const article = src(2, 'Substack', 'https://example.com/a')
    const episode = src(3, 'Askwho Casts', 'https://app.askwhocasts.com/f/s/media/x.mp3')
    const spotifyPost = { sources: [spotify, article], platform: 'Spotify', link: spotify.link } as Partial<QueueItem>

    it('offers Convert on a Spotify post with an article', () => {
      const { getAllByRole } = renderList([makeItem({ id: 1 }), makeItem({ id: 2, queuePosition: 2, ...spotifyPost })], { onConvert: noop })
      openListMenu(getAllByRole)
      expect(screen.getByRole('menuitem', { name: /Convert with Askwho Casts/ })).toBeTruthy()
    })
    it('still hides ElevenReader on that post', () => {
      const { getAllByRole } = renderList([makeItem({ id: 1 }), makeItem({ id: 2, queuePosition: 2, ...spotifyPost })], { onConvert: noop, onListen: noop })
      openListMenu(getAllByRole)
      expect(screen.queryByRole('menuitem', { name: /ElevenReader/ })).toBeNull()
    })
    it('shows conversion progress on that post', () => {
      renderList([makeItem({ id: 1, ...spotifyPost, awcConversion: conv('building_script') })], { onConvert: noop })
      expect(screen.getByText('Writing script')).toBeTruthy()
    })
    it.each([
      ['a podcast episode with no article', [spotify]],
      ['a post with a private episode', [spotify, article, episode]],
      ['a post with a public copy', [article, src(4, 'Spotify', 'https://open.spotify.com/episode/y', false, 'AI Article Readings')]],
    ])('does not offer Convert on %s', (_name, sources) => {
      const { getAllByRole } = renderList([makeItem({ id: 1 }), makeItem({ id: 2, queuePosition: 2, sources })], { onConvert: noop })
      openListMenu(getAllByRole)
      expect(screen.queryByRole('menuitem', { name: /Convert with Askwho Casts/ })).toBeNull()
    })
    it('lists the episode above Spotify in a card menu', () => {
      const { getAllByRole } = renderList([makeItem({ id: 1 }), makeItem({ id: 2, queuePosition: 2, sources: [spotify, article, episode] })])
      openListMenu(getAllByRole)
      const labels = screen.getAllByRole('menuitem').map((m) => m.textContent)
      expect(labels.findIndex((l) => l?.includes('Askwho Casts'))).toBeLessThan(labels.findIndex((l) => l?.includes('Spotify')))
    })
    it('points hero START at the episode, with the other sources in its menu', () => {
      renderList([makeItem({ id: 1, sources: [spotify, article, episode], platform: 'Spotify', link: spotify.link })])
      const start = screen.getByRole('link', { name: /START ON ASKWHO CASTS/ })
      expect(start.getAttribute('href')).toBe(episode.link)
      const trigger = start.closest('div')!.querySelector('button[aria-haspopup="menu"]')!
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
      expect(screen.getByRole('menuitem', { name: /Open on Spotify/ })).toBeTruthy()
      expect(screen.getByRole('menuitem', { name: /Open on Substack/ })).toBeTruthy()
      expect(screen.queryByRole('menuitem', { name: /Open on Askwho Casts/ })).toBeNull()
    })
    it('leaves hero START on the primary source without an episode', () => {
      renderList([makeItem({ id: 1, ...spotifyPost })])
      expect(screen.getByRole('link', { name: /START ON SPOTIFY/ }).getAttribute('href')).toBe(spotify.link)
    })
  })

  it('keeps the original label when there is no conversion', () => {
    const { getAllByRole } = renderList([makeItem({ id: 1 }), makeItem({ id: 2, queuePosition: 2 })], { onConvert: noop })
    openListMenu(getAllByRole)
    expect(screen.getByRole('menuitem', { name: /Convert with Askwho Casts/ })).toBeTruthy()
  })
})

it('hides a failed AWC pill once the item has audio (episode arrived anyway) (#317)', () => {
  renderList([makeItem({
    id: 1,
    awcConversion: { id: 9, status: 'failed', error: 'x', requestedAt: 'r', updatedAt: 'u' },
    sources: [
      { id: 1, platform: 'Substack', link: 'https://example.com/a', messageId: null, isPrimary: true, createdAt: 'c', sourceLabel: null },
      { id: 2, platform: 'Askwho Casts', link: 'https://m/1.mp3', messageId: null, isPrimary: false, createdAt: 'c', sourceLabel: null },
    ],
  })])
  expect(screen.queryByText('Failed')).toBeNull()
})

// #377: the feed home shows Claude's picks; /everything shows the pile.
describe('home view (#377)', () => {
  const picks = () => [
    makeItem({ id: 1, title: 'Hero Pick' }),
    makeItem({ id: 2, title: 'Second Pick' }),
    makeItem({ id: 3, title: 'Third Pick' }),
  ]
  const homeProps = (over: Partial<ComponentProps<typeof ReadingList>> = {}) => ({
    view: 'home' as const,
    reasons: new Map([[1, 'New episode; you finish these'], [2, '71% in, 50 min left']]),
    freshness: { label: 'Picks updated 2h ago', stale: false },
    everythingCount: 329,
    onNotNow: vi.fn().mockResolvedValue(undefined),
    ...over,
  })

  it('renders no search, filter or sort controls', () => {
    const view = renderList(picks(), homeProps())
    expect(view.queryByRole('button', { name: /^Filters/ })).toBeNull()
    expect(view.queryByRole('searchbox')).toBeNull()
    expect(view.queryByPlaceholderText(/Search/)).toBeNull()
    expect(view.queryByText('QUEUE')).toBeNull()
  })

  it('shows reasons on one truncated line, only where given', () => {
    const view = renderList(picks(), homeProps())
    const hero = view.getByText('New episode; you finish these')
    const card = view.getByText('71% in, 50 min left')
    expect(hero.className).toMatch(/\btruncate\b/)
    expect(card.className).toMatch(/\btruncate\b/)
    const third = view.getByText('Third Pick').closest('.rounded-xl') as HTMLElement
    expect(within(third).queryByTestId('pick-reason')).toBeNull()
  })

  it('shows the freshness line and the Everything else link', () => {
    const view = renderList(picks(), homeProps())
    expect(view.getByText('Picks updated 2h ago')).toBeTruthy()
    const link = view.getByRole('link', { name: 'Everything else · 329 items' })
    expect(link.getAttribute('href')).toBe('/everything')
  })

  it('marks a stale freshness line', () => {
    const view = renderList(picks(), homeProps({ freshness: { label: 'Picks updated 30h ago', stale: true } }))
    expect(view.getByText('Picks updated 30h ago').getAttribute('data-stale')).toBe('true')
  })

  it('offers Not now in a list card menu', () => {
    const onNotNow = vi.fn().mockResolvedValue(undefined)
    const view = renderList(picks(), homeProps({ onNotNow }))
    const card = view.getByText('Second Pick').closest('.rounded-xl') as HTMLElement
    const trigger = within(card).getAllByRole('button').find(b => b.getAttribute('aria-haspopup') === 'menu')!
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(view.getByRole('menuitem', { name: 'Not now' }))
    expect(onNotNow).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
  })

  it('offers Not now in the hero menu', () => {
    const onNotNow = vi.fn().mockResolvedValue(undefined)
    const view = renderList(picks(), homeProps({ onNotNow }))
    const hero = view.getByRole('region', { name: 'Current item' })
    const triggers = within(hero).getAllByRole('button').filter(b => b.getAttribute('aria-haspopup') === 'menu')
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })
    fireEvent.click(view.getByRole('menuitem', { name: 'Not now' }))
    expect(onNotNow).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }))
  })

  it('has no drag handles', () => {
    const { container } = renderList(picks(), homeProps())
    expect(container.querySelector('.cursor-grab')).toBeNull()
  })

  it('links to Everything from the empty state', () => {
    const view = renderList([], homeProps({ everythingCount: 12 }))
    expect(view.getByRole('link', { name: 'Everything else · 12 items' })).toBeTruthy()
  })
})

describe('pile view (#377)', () => {
  const pile = () => [
    makeItem({ id: 1, title: 'Newest Post' }),
    makeItem({ id: 2, title: 'Picked Post' }),
    makeItem({ id: 3, title: 'Older Post' }),
  ]
  const pileProps = (over: Partial<ComponentProps<typeof ReadingList>> = {}) => ({
    view: 'pile' as const,
    sortDirection: 'newest' as const,
    pickIds: new Set([2]),
    ...over,
  })

  it('renders every item as a list card, with no hero', () => {
    const view = renderList(pile(), pileProps())
    expect(view.queryByRole('region', { name: 'Current item' })).toBeNull()
    expect(view.queryByRole('heading', { level: 1 })).toBeNull()
    for (const title of ['Newest Post', 'Picked Post', 'Older Post']) expect(view.getByText(title)).toBeTruthy()
  })

  it('puts a PICK pill only on current picks', () => {
    const view = renderList(pile(), pileProps())
    expect(view.getAllByText('PICK')).toHaveLength(1)
    const picked = view.getByText('Picked Post').closest('.rounded-xl') as HTMLElement
    expect(within(picked).getByText('PICK')).toBeTruthy()
  })

  it('offers only Newest first and Oldest first', () => {
    const onSortChange = vi.fn()
    const view = renderList(pile(), pileProps({ onSortChange }))
    const triggers = view.getAllByRole('button').filter(b => b.getAttribute('aria-haspopup') === 'menu')
    fireEvent.pointerDown(triggers[0], { button: 0, ctrlKey: false })
    const names = view.getAllByRole('menuitem').map(m => m.textContent)
    expect(names).toEqual(['Newest first', 'Oldest first'])
    fireEvent.click(view.getByRole('menuitem', { name: 'Oldest first' }))
    expect(onSortChange).toHaveBeenCalledWith('oldest')
  })

  it('keeps search and filters', () => {
    const view = renderList(pile(), pileProps())
    expect(view.getByRole('button', { name: /^Filters/ })).toBeTruthy()
    expect(view.getByPlaceholderText('Search everything')).toBeTruthy()
  })

  it('links back to the picks', () => {
    const view = renderList(pile(), pileProps())
    expect(view.getByRole('link', { name: 'Back to picks' }).getAttribute('href')).toBe('/')
  })

  it('has no drag handles and no Not now', () => {
    const { container } = renderList(pile(), pileProps())
    expect(container.querySelector('.cursor-grab')).toBeNull()
  })

  it('tapping a card makes it next', () => {
    const onMakeNext = vi.fn().mockResolvedValue(undefined)
    const view = renderList(pile(), pileProps({ onMakeNext }))
    fireEvent.click(view.getByText('Older Post'))
    expect(onMakeNext).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }))
  })
})

describe('legacy AI-suggestion treatment is gone (#377)', () => {
  it('never renders the dashed card or Confirm / Skip for an unconfirmed position', () => {
    const items = [
      makeItem({ id: 1, title: 'Top' }),
      makeItem({ id: 2, title: 'Suggested', queuePosition: 5, positionConfirmed: false }),
    ]
    const onMakeNext = vi.fn().mockResolvedValue(undefined)
    const view = renderList(items, { view: 'home', onMakeNext })
    expect(view.container.querySelector('.border-dashed.border-primary\\/30')).toBeNull()
    expect(view.queryByRole('button', { name: 'Confirm' })).toBeNull()
    fireEvent.click(view.getByText('Suggested'))
    expect(onMakeNext).toHaveBeenCalledTimes(1)
  })

  it('books still render drag handles and all four sort options', () => {
    const books = [
      makeItem({ id: 1, title: 'Book One', kind: 'book' }),
      makeItem({ id: 2, title: 'Book Two', kind: 'book', queuePosition: 2 }),
    ]
    const view = renderList(books, { kind: 'book' })
    expect(view.container.querySelector('.cursor-grab')).not.toBeNull()
    const triggers = view.getAllByRole('button').filter(b => b.getAttribute('aria-haspopup') === 'menu')
    fireEvent.pointerDown(triggers[0], { button: 0, ctrlKey: false })
    expect(view.getAllByRole('menuitem').map(m => m.textContent)).toEqual(['Queue order', 'Newest first', 'Oldest first', 'Recommended'])
  })
})

describe('feed cards ignore a legacy queue position for source order (#377)', () => {
  it('a pile card with legacy position 1 still leads with the text source', () => {
    const sources = [
      { id: 11, platform: 'Spotify', link: 'https://open.spotify.com/episode/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
      { id: 12, platform: 'Substack', link: 'https://example.substack.com/p/x', messageId: null, isPrimary: false, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
    ]
    const items = [makeItem({ id: 5, title: 'Legacy Top', queuePosition: 1, sources, platform: 'Spotify', link: sources[0].link })]
    const view = renderList(items, { view: 'pile', sortDirection: 'newest' })
    const card = view.getByText('Legacy Top').closest('.rounded-xl') as HTMLElement
    const trigger = within(card).getAllByRole('button').find(b => b.getAttribute('aria-haspopup') === 'menu')!
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    expect(view.getAllByRole('menuitem')[0].textContent).toContain('Substack')
  })
})

describe('pile view: picks stand out, Not now, NEW (#377 follow-up)', () => {
  const pile = () => [
    makeItem({ id: 1, title: 'Plain Post' }),
    makeItem({ id: 2, title: 'Picked Post' }),
    makeItem({ id: 3, title: 'Fresh Post' }),
  ]
  const props = (over: Partial<ComponentProps<typeof ReadingList>> = {}) => ({
    view: 'pile' as const,
    sortDirection: 'newest' as const,
    pickIds: new Set([2]),
    newIds: new Set([3]),
    onNotNow: vi.fn().mockResolvedValue(undefined),
    ...over,
  })
  const cardOf = (view: ReturnType<typeof renderList>, title: string) =>
    view.getByText(title).closest('[data-card]') as HTMLElement
  const menuItemsOf = (view: ReturnType<typeof renderList>, title: string) => {
    const trigger = within(cardOf(view, title)).getAllByRole('button').find(b => b.getAttribute('aria-haspopup') === 'menu')!
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    return view.getAllByRole('menuitem').map(m => m.textContent)
  }

  it('highlights cards that are on home', () => {
    const view = renderList(pile(), props())
    expect(cardOf(view, 'Picked Post').getAttribute('data-pick')).toBe('true')
    expect(cardOf(view, 'Picked Post').className).toMatch(/border-primary/)
    expect(cardOf(view, 'Plain Post').getAttribute('data-pick')).toBe('false')
    expect(cardOf(view, 'Plain Post').className).not.toMatch(/border-primary/)
  })

  it('offers Not now only on cards that are on home', () => {
    const onNotNow = vi.fn().mockResolvedValue(undefined)
    const view = renderList(pile(), props({ onNotNow }))
    expect(menuItemsOf(view, 'Picked Post')).toContain('Not now')
    fireEvent.click(view.getByRole('menuitem', { name: 'Not now' }))
    expect(onNotNow).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
  })

  it('has no Not now on a card that is not on home', () => {
    const view = renderList(pile(), props())
    expect(menuItemsOf(view, 'Plain Post')).not.toContain('Not now')
  })

  it('marks new items with a NEW badge', () => {
    const view = renderList(pile(), props())
    expect(within(cardOf(view, 'Fresh Post')).getByText('NEW')).toBeTruthy()
    expect(within(cardOf(view, 'Plain Post')).queryByText('NEW')).toBeNull()
  })
})

describe('Per-item Feedback box removed (#380)', () => {
  const menuTriggers = (root: HTMLElement) =>
    within(root).queryAllByRole('button').filter((b) => b.getAttribute('aria-haspopup') === 'menu')

  it('offers no Feedback action in the hero or list-card menus', () => {
    const { getByRole, unmount } = renderList(
      [
        makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
        makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
      ],
      { onNotNow: noop },
    )

    const hero = getByRole('region', { name: 'Current item' })
    fireEvent.pointerDown(within(hero).getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false })
    const heroMenu = within(getByRole('menu'))
    expect(heroMenu.getByRole('menuitem', { name: /Not now/ })).toBeTruthy()
    expect(heroMenu.queryByRole('menuitem', { name: /Feedback/ })).toBeNull()
    unmount()

    const second = renderList([
      makeItem({ id: 1, title: 'Top Item', queuePosition: 1 }),
      makeItem({ id: 2, title: 'Second Item', queuePosition: 2 }),
    ])
    const triggers = second.getAllByRole('button').filter((b) => b.getAttribute('aria-haspopup') === 'menu')
    fireEvent.pointerDown(triggers[triggers.length - 1], { button: 0, ctrlKey: false })
    const cardMenu = within(second.getByRole('menu'))
    expect(cardMenu.getByRole('menuitem', { name: /Skip/ })).toBeTruthy()
    expect(cardMenu.queryByRole('menuitem', { name: /Feedback/ })).toBeNull()
  })

  it('hides the hero ⋯ menu when it would have no actions (books)', () => {
    const physical = {
      kind: 'book' as const,
      sources: [
        { id: 3, platform: 'Physical', link: null, messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
      ],
      platform: 'Physical',
      link: '',
    }
    const { getByRole } = renderList(
      [
        makeItem({ id: 1, queuePosition: 1, title: 'Hero Book', ...physical }),
        makeItem({ id: 2, queuePosition: 2, title: 'Card Book', ...physical, sources: [{ ...physical.sources[0], id: 4 }] }),
      ],
      { kind: 'book' },
    )
    const hero = getByRole('region', { name: 'Current item' })
    expect(within(hero).queryByRole('button', { name: 'More actions' })).toBeNull()
    expect(menuTriggers(hero)).toHaveLength(0)
    // Complete / Skip stay.
    expect(within(hero).getByRole('button', { name: 'Complete' })).toBeTruthy()
  })
})
