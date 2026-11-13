// Fixtures for the /settings/link-lab on-device diagnostic (#267).
//
// Every URL here has the shape of a real stored source link, so what
// you tap on-device is what the queue would actually render. `expected` is the
// app the SHIPPED href should hand off to — after the custom-domain Substack
// bridge, where it applies (null = no registration, so it must escape to real
// Safari). fixtures.test.ts pins each one against handoffTarget(), so this
// file cannot drift into lying.

export interface LinkLabCase {
  /** Unique, so on-device notes are unambiguous. */
  label: string
  url: string
  /** content_sources platform label, where it is load-bearing or notable. */
  platform?: string
  /** App handoffTarget() should name, or null for a Safari control. */
  expected: string | null
  /** Why this row is in the lab. */
  note?: string
}

export interface LinkLabGroup {
  title: string
  description: string
  cases: LinkLabCase[]
}

export const LINK_LAB_GROUPS: LinkLabGroup[] = [
  {
    title: 'Substack',
    description:
      'The reported bug (#267). All of these are AASA-registered, so each should open the Substack app. Any that opens the in-app sheet instead is either a per-domain "prefer web" opt-out (long-press → Open in Substack to clear it) or a genuine handoff failure.',
    cases: [
      {
        label: 'Substack — publication subdomain',
        url: 'https://thezvi.substack.com/p/anthropic-commits-to-model-weight',
        platform: 'Substack',
        expected: 'Substack',
        note: 'The most common shape of stored Substack link.',
      },
      {
        label: 'Substack — custom domain, bridged (the reported bug)',
        url: 'https://www.astralcodexten.com/p/highlights-from-the-comments-on-fatima',
        platform: 'Substack',
        expected: 'Substack',
        note: 'Custom domains serve Substack AASA but are NOT in the app entitlement, so the raw URL never hands off — the exact on-device failure that reopened #267. The shipped href is bridged to open.substack.com/pub/astralcodexten/…, which does hand off.',
      },
      {
        label: 'Substack — open.substack.com',
        url: 'https://open.substack.com/pub/thezvi/p/ai-140-trying-to-hold-the-line',
        platform: 'Substack',
        expected: 'Substack',
        note: "Substack's own open-in-app host; registers '*'. If the subdomain row above fails but this one works, a per-domain opt-out is the cause.",
      },
      {
        label: 'Substack — custom domain, mislabelled platform',
        url: 'https://www.dwarkesh.com/p/bits-per-sample',
        platform: 'Website',
        expected: 'Substack',
        note: 'Finding 2: production files this under "Website". The bridge is host-keyed, so the wrong label does not matter.',
      },
      {
        label: 'Substack — migrated subdomain (must escape)',
        url: 'https://astralcodexten.substack.com/p/highlights-from-the-comments-on-fatima',
        platform: 'Substack',
        expected: null,
        note: 'Finding 7: this publication moved to www.astralcodexten.com and Substack now 301s the whole old subdomain, AASA included — so it cannot hand off. Some stored rows sit on hosts like this; pre-#267 every one was kept plain and stranded.',
      },
      {
        label: 'Substack — unregistered path (must escape)',
        url: 'https://substack.com/home/post/p-200415560',
        platform: 'Substack',
        expected: null,
        note: 'Finding 5: /home/* is not in the AASA. Kept plain it would strand in the in-app sheet, so it must reach Safari.',
      },
    ],
  },
  {
    title: 'Audio platforms',
    description: 'Handoffs shipped in #236 and #246 — these must not regress.',
    cases: [
      {
        label: 'Spotify — episode',
        url: 'https://open.spotify.com/episode/3MYSir4mn287G11fyewgFG',
        platform: 'Spotify',
        expected: 'Spotify',
      },
      {
        label: 'Apple Podcasts — Library',
        url: 'https://podcasts.apple.com/library',
        expected: 'Apple Podcasts',
        note: 'Where Askwho Casts sources land on iOS (#236).',
      },
      {
        label: 'Askwho Casts — raw enclosure (must escape)',
        url: 'https://app.askwhocasts.com/f/notasecret/media/sample.mp3',
        platform: 'Askwho Casts',
        expected: null,
        note: 'The queue swaps this for the Apple Podcasts Library link; tapped directly it must reach Safari.',
      },
    ],
  },
  {
    title: 'Newly added in #267',
    description:
      'Finding 3 — AASA-registered all along, but previously forced to Safari. IMPORTANT: keep-plain is a bet. If one of these apps is NOT installed, the link no longer reaches Safari — it opens the in-app browser sheet, which is worse than the behaviour before #267. Check each of these rows carefully.',
    cases: [
      {
        label: 'YouTube — watch',
        url: 'https://www.youtube.com/watch?v=Km2bn0HvUwg',
        platform: 'YouTube',
        expected: 'YouTube',
      },
      {
        label: 'YouTube — youtu.be short link',
        url: 'https://youtu.be/8-boBsWcr5A',
        platform: 'Spotify',
        expected: 'YouTube',
        note: 'Matched by host, not by the platform label, which production has wrong here.',
      },
      {
        label: 'YouTube — bare apex (must escape)',
        url: 'https://youtube.com/watch?v=Km2bn0HvUwg',
        platform: 'YouTube',
        expected: null,
        note: 'Finding 7: youtube.com 301s its AASA to www, so the apex is not associated. Compare with the www row above — same video, different outcome.',
      },
      {
        label: 'Goodreads — book',
        url: 'https://www.goodreads.com/book/show/213395473',
        platform: 'Goodreads',
        expected: 'Goodreads',
      },
      {
        label: 'Audible — product page',
        url: 'https://www.audible.com/pd/B0DF371HQM',
        platform: 'Audible',
        expected: 'Audible',
      },
    ],
  },
  {
    title: 'Safari controls',
    description:
      'Finding 4 — no native app or no applinks AASA, so these must open in REAL Safari, never the in-app sheet. If these land in the sheet, the x-safari- escape itself is broken and every other result here is suspect.',
    cases: [
      {
        label: 'LessWrong — post',
        url: 'https://www.lesswrong.com/posts/mXtYM3yTzdsnFq3MA/asking-some-of-the-right-questions',
        platform: 'LessWrong',
        expected: null,
      },
      {
        label: 'NYT — column (webcredentials only, no applinks)',
        url: 'https://www.nytimes.com/column/ezra-klein-podcast',
        platform: 'Website',
        expected: null,
      },
    ],
  },
]
