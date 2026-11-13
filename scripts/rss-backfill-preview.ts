/**
 * RSS backfill — interactive preview (READ-ONLY).
 *
 * Fetches every active feed, classifies each post from the last 90 days as
 * already-in-queue / missing / ambiguous (via lib/sync/backfill), and renders a
 * static interactive HTML page to scratch/rss-backfill.html. In that page you
 * pick a per-feed cutoff ("go back to here"); every MISSING post from that point
 * to today is selected. A "Download selection" button writes the selection JSON
 * that scripts/rss-backfill-apply.ts consumes.
 *
 * Target DB: defaults to whatever .env.local points at (PROD). Override for
 * local testing by exporting SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY first:
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local> \
 *     pnpm dlx tsx scripts/rss-backfill-preview.ts
 *
 * This script never writes to the database.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Type-only import — erased at runtime, so it does not pull in the
// @/lib/supabase singleton before env is configured below.
import type { RssItem } from '../lib/rss/parser'

const WINDOW_DAYS = 90

/** Populate process.env from .env.local WITHOUT clobbering already-set vars,
 *  so CLI/exported overrides (e.g. a local SUPABASE_URL) take precedence. */
function loadEnvIntoProcess() {
  let raw: string
  try {
    raw = readFileSync(resolve('.env.local'), 'utf8')
  } catch {
    return // rely entirely on exported env
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    if (key in process.env) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    process.env[key] = v
  }
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// RLV-005: serialize untrusted feed data for embedding inside an inline <script>.
// Plain JSON.stringify does NOT escape `<`, so a post titled `</script><script>…`
// breaks out of the element at HTML-parse time and runs attacker JS on-origin —
// in a page whose "Download selection JSON" then drives PROD writes. Escaping `<`
// (plus the JS line separators U+2028/U+2029) makes the payload inert.
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

interface FeedBlock {
  feedId: number
  label: string
  platform: string
  posts: {
    publishedOn: string | null
    title: string
    status: 'matched' | 'missing' | 'ambiguous'
    item: Record<string, unknown>
  }[]
}

function renderHtml(target: string, runAt: string, feeds: FeedBlock[]): string {
  const data = scriptJson(feeds)
  // The client script builds the DOM with createElement + textContent only
  // (no innerHTML), so external feed titles can never inject markup once inside
  // the DOM. scriptJson additionally neutralizes `</script>` breakout at the
  // point where the untrusted data is embedded into the inline <script> (RLV-005).
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>RSS Backfill — Select</title>
<style>
  :root { --missing:#2e7d32; --missing-bg:#e8f5e9; --matched:#9e9e9e; --amb:#c62828; --amb-bg:#ffebee; --border:#e0e0e0; --muted:#757575; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; max-width:1100px; margin:0 auto; padding:24px 24px 120px; color:#212121; line-height:1.5; }
  h1 { margin:0 0 4px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:24px; }
  .meta code { background:#f5f5f5; padding:2px 6px; border-radius:3px; }
  .feed { border:1px solid var(--border); border-radius:8px; margin-bottom:18px; overflow:hidden; }
  .feed > summary { cursor:pointer; padding:12px 16px; background:#fafafa; font-weight:600; display:flex; gap:10px; align-items:baseline; list-style:none; }
  .feed > summary::-webkit-details-marker { display:none; }
  .feed > summary::before { content:"\\25B8"; color:var(--muted); }
  .feed[open] > summary::before { content:"\\25BE"; }
  .feed .plat { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.5px; }
  .feed .sel { margin-left:auto; font-size:13px; font-weight:600; color:var(--missing); }
  .feed .sel.zero { color:var(--muted); font-weight:400; }
  .clear { margin-left:8px; font-size:12px; color:#1565c0; background:none; border:none; cursor:pointer; text-decoration:underline; padding:0; }
  .rows { padding:4px 0; }
  .row { display:flex; gap:12px; align-items:baseline; padding:7px 16px; border-top:1px solid #f2f2f2; cursor:pointer; }
  .row.matched { cursor:default; opacity:.55; }
  .row.ambiguous { cursor:default; }
  .row.selected { background:var(--missing-bg); border-left:3px solid var(--missing); }
  .row.cutoff { box-shadow:inset 0 -2px 0 var(--missing); }
  .row .date { font-family:ui-monospace,monospace; font-size:12px; color:#555; min-width:92px; }
  .row .title { flex:1; }
  .row .badge { font-size:10px; font-weight:700; letter-spacing:.5px; padding:1px 7px; border-radius:3px; }
  .badge.missing { background:var(--missing); color:#fff; }
  .badge.matched { background:#eee; color:var(--matched); }
  .badge.ambiguous { background:var(--amb); color:#fff; }
  .hint { font-size:12px; color:var(--muted); padding:6px 16px 2px; }
  .bar { position:fixed; left:0; right:0; bottom:0; background:#fff; border-top:1px solid var(--border); padding:14px 24px; display:flex; gap:16px; align-items:center; box-shadow:0 -2px 8px rgba(0,0,0,.05); }
  .bar .total { font-weight:600; }
  .bar button.dl { margin-left:auto; background:var(--missing); color:#fff; border:none; padding:10px 18px; border-radius:6px; font-size:14px; cursor:pointer; }
  .bar button.dl:disabled { background:#bdbdbd; cursor:not-allowed; }
</style>
</head>
<body>
<h1>RSS Backfill — Select posts to import</h1>
<div class="meta">Target <code>${htmlEscape(target)}</code> · Generated ${htmlEscape(runAt)} · Last ${WINDOW_DAYS} days per feed.
Click a <b>missing</b> post to set the cutoff — everything from that post up to today is selected. Click again to clear.</div>
<div id="feeds"></div>
<div class="bar">
  <span class="total" id="total">0 posts selected</span>
  <span style="color:#757575;font-size:13px">across <span id="feedcount">0</span> feed(s)</span>
  <button class="dl" id="dl" disabled>Download selection JSON</button>
</div>
<script>
const FEEDS = ${data};
const TARGET = ${scriptJson(target)};
const WINDOW_DAYS = ${WINDOW_DAYS};
const cutoff = {}; // feedId -> index of cutoff row (inclusive), or undefined

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

function selectedIdxs(f) {
  const c = cutoff[f.feedId];
  if (c === undefined) return [];
  const out = [];
  for (let i = 0; i <= c; i++) if (f.posts[i].status === 'missing') out.push(i);
  return out;
}

function render() {
  const root = document.getElementById('feeds');
  root.replaceChildren();
  let total = 0, feedsWith = 0;
  for (const f of FEEDS) {
    const sel = selectedIdxs(f);
    if (sel.length) feedsWith++;
    total += sel.length;
    const missing = f.posts.filter(p => p.status === 'missing').length;

    const d = el('details', 'feed');
    d.open = missing > 0;
    const summary = el('summary');
    summary.appendChild(el('span', null, f.label));
    summary.appendChild(el('span', 'plat', f.platform));
    summary.appendChild(el('span', sel.length ? 'sel' : 'sel zero', sel.length + ' selected'));
    if (sel.length) {
      const clr = el('button', 'clear', 'clear');
      clr.addEventListener('click', (e) => { e.preventDefault(); cutoff[f.feedId] = undefined; render(); });
      summary.appendChild(clr);
    }
    d.appendChild(summary);

    const rows = el('div', 'rows');
    if (missing === 0) {
      rows.appendChild(el('div', 'hint', 'No missing posts in the last ' + WINDOW_DAYS + ' days — fully ingested.'));
    }
    f.posts.forEach((p, i) => {
      const isSel = sel.includes(i);
      const isCut = cutoff[f.feedId] === i;
      const row = el('div', 'row ' + p.status + (isSel ? ' selected' : '') + (isCut ? ' cutoff' : ''));
      row.appendChild(el('span', 'date', p.publishedOn || '—'));
      row.appendChild(el('span', 'title', p.title));
      row.appendChild(el('span', 'badge ' + p.status, p.status));
      if (p.status === 'missing') {
        row.addEventListener('click', () => {
          cutoff[f.feedId] = (cutoff[f.feedId] === i) ? undefined : i;
          render();
        });
      }
      rows.appendChild(row);
    });
    d.appendChild(rows);
    root.appendChild(d);
  }
  document.getElementById('total').textContent = total + ' post' + (total === 1 ? '' : 's') + ' selected';
  document.getElementById('feedcount').textContent = feedsWith;
  document.getElementById('dl').disabled = total === 0;
}

function buildSelection() {
  const feeds = [];
  for (const f of FEEDS) {
    const idxs = selectedIdxs(f);
    if (!idxs.length) continue;
    const posts = idxs.map(i => f.posts[i].item);
    const dates = idxs.map(i => f.posts[i].publishedOn).filter(Boolean);
    feeds.push({ feedId: f.feedId, label: f.label, platform: f.platform,
      cutoffDate: dates.length ? dates[dates.length - 1] : null, posts });
  }
  return { generatedAt: new Date().toISOString(), target: TARGET,
    totalPosts: feeds.reduce((n, f) => n + f.posts.length, 0), feeds };
}

document.getElementById('dl').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(buildSelection(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rss-backfill-selection.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

render();
</script>
</body>
</html>
`
}

async function main() {
  loadEnvIntoProcess()

  // Dynamic-import AFTER env is populated so the @/lib/supabase singleton
  // (used transitively by feeds-repo) targets the intended DB.
  const RssParser = (await import('rss-parser')).default
  const { listFeeds } = await import('../lib/rss/feeds-repo')
  const { fetchFeed } = await import('../lib/rss/fetch-feed')
  const { parseRssItems } = await import('../lib/rss/parser')
  const { classifyFeedPosts } = await import('../lib/sync/backfill')
  const { supabase, supabaseUrl } = await import('../lib/supabase')

  console.log(`Target: ${supabaseUrl} (READ-ONLY)`)

  const parser = new RssParser()
  const feeds = await listFeeds({ includeDisabled: false })
  const blocks: FeedBlock[] = []

  for (const feed of feeds) {
    process.stdout.write(`[${feed.label}] fetching... `)
    let parsed
    try {
      // fetchFeed, not parser.parseURL: SSRF-guarded + body-capped (#281, F12)
      parsed = await fetchFeed(feed.url, parser)
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`)
      continue
    }
    const items = parseRssItems(parsed.items as RssItem[], feed)
    const classified = await classifyFeedPosts(items, supabase, { windowDays: WINDOW_DAYS })
    const missing = classified.filter((c) => c.status === 'missing').length
    console.log(`${classified.length} in window, ${missing} missing`)
    blocks.push({
      feedId: feed.id,
      label: feed.label,
      platform: feed.platform,
      posts: classified.map((c) => ({
        publishedOn: c.publishedOn,
        title: c.item.title,
        status: c.status,
        item: { ...c.item },
      })),
    })
  }

  const html = renderHtml(supabaseUrl, new Date().toISOString(), blocks)
  const outPath = 'scratch/rss-backfill.html'
  writeFileSync(outPath, html)

  const totalMissing = blocks.reduce(
    (n, b) => n + b.posts.filter((p) => p.status === 'missing').length,
    0
  )
  console.log(`\nFeeds: ${blocks.length}/${feeds.length} fetched`)
  console.log(`Total missing posts (selectable): ${totalMissing}`)
  console.log(`\nOpen ${outPath} in a browser, pick per-feed cutoffs, then Download selection JSON.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
