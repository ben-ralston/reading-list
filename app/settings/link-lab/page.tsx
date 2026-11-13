'use client'

// /settings/link-lab — on-device link handoff diagnostic (#267).
//
// None of the iOS handoff behaviour this app depends on is reproducible in a
// desktop browser: universal-link handoff, the x-safari- escape, and the
// layered in-app browser sheet only exist in the home-screen PWA. This page
// turns "why does Substack open in the in-app browser?" from an unanswerable
// question into a tap-through: each row renders the href the queue would
// actually use, alongside the plain and force-Safari variants, so a failing
// handoff can be isolated to the URL shape, the domain, or the escape itself.
//
// Anchors are real <a> elements for the same reason the queue's are — iOS only
// treats a genuine tap on an anchor as universal-link-eligible (#197) — and the
// href transform is hydration-gated via useHydrated() because this page is SSR'd.
//
// app/settings/layout.tsx renders the back link, "Settings" heading and nav.

import { externalHref, handoffTarget, isIos, isStandalonePwa } from '@/lib/links'
import { useHydrated } from '@/lib/use-hydrated'
import { LINK_LAB_GROUPS, type LinkLabCase } from './fixtures'

function EnvReadout({ hydrated }: { hydrated: boolean }) {
  // Before hydration these would report the server's answer (always false), so
  // say so rather than showing a misleading value.
  const rows: [string, string][] = hydrated
    ? [
        ['isIos()', String(isIos())],
        ['isStandalonePwa()', String(isStandalonePwa())],
        ['x-safari- active', String(isIos() && isStandalonePwa())],
      ]
    : [['detecting…', '—']]
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-xs text-muted-foreground">{k}</dt>
          <dd className="font-mono text-xs">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function LinkRow({ testCase, hydrated }: { testCase: LinkLabCase; hydrated: boolean }) {
  const { url, platform, expected, label, note } = testCase
  const shipped = hydrated ? externalHref(url) : url
  const escaped = `x-safari-${url}`
  const destination = expected ? `${expected} app` : 'Real Safari'
  // Recomputed rather than trusting the fixture, so a registry change shows up
  // here immediately even if the fixture were somehow stale.
  const matched = handoffTarget(url)

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-sm">{label}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          expect (in the PWA): {destination}
        </span>
      </div>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{url}</p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        platform: {platform ?? '—'} · registry: {matched ?? 'no match → x-safari-'}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={shipped}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
        >
          Open as shipped
        </a>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium"
        >
          Open plain
        </a>
        {/* Same target/rel as every shipped anchor (components/reading-list.tsx),
            so this control is a like-for-like test of the x-safari- escape
            rather than a subtly different navigation. */}
        <a
          href={escaped}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium"
        >
          Force Safari
        </a>
      </div>
      <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
        as shipped → {shipped}
      </p>
    </li>
  )
}

export default function LinkLabPage() {
  const hydrated = useHydrated()

  return (
    <>
      <h2 className="mt-6 text-xl font-semibold">Link lab</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Tap-through harness for iOS link handoff. Open this from the{' '}
        <strong>home-screen PWA</strong> (not a Safari tab — the behaviour differs) and record
        where each row lands: the native app, real Safari, or the in-app browser sheet layered
        over this page. <strong>Open as shipped</strong> is the href the queue would render;{' '}
        <strong>Open plain</strong> and <strong>Force Safari</strong> are the two ends of the
        trade-off, for isolating a failure.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        If a Substack row lands in the in-app sheet, long-press it → <strong>Open in Substack</strong>{' '}
        to clear a per-domain &ldquo;prefer web&rdquo; opt-out, then tap it again. That distinguishes
        an iOS preference from a real handoff failure.
      </p>

      <EnvReadout hydrated={hydrated} />

      {LINK_LAB_GROUPS.map((group) => (
        <section key={group.title} className="mt-6">
          <h3 className="text-base font-semibold">{group.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{group.description}</p>
          <ul className="mt-2 space-y-2">
            {group.cases.map((testCase) => (
              <LinkRow key={testCase.label} testCase={testCase} hydrated={hydrated} />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}
