// Builds a LessWrong post's comments episode script (#368). Deterministic and
// daemon-only: the agent never reads the comments, it only pastes the result, so
// it can't summarise them or be steered by them while choosing what to include.
//
// Askwho Casts finds speakers from double quotes and starts a chapter at a line
// beginning with #, so everything a commenter says sits on one line inside one
// pair of quotes, and the text itself never contains a double quote.
import { JSDOM } from 'jsdom'

// Every comment is read unless the episode would pass 90 minutes; then the
// lowest-scoring ones go first.
// 90 minutes: a script of about 14,000 words comes to roughly 89 minutes (#368).
// Measured on the rendered text; LessWrong's own wordCount runs about 30% low.
export const MAX_WORDS = 14_400
export const MIN_WORDS = 200
export const MAX_CREDITS = 100
const WORDS_PER_MINUTE = 160
// The most fixed narration a comment can add around its own line: "## Thread 12
// of 56, 34 comments" on a root, or "Back to the top comment, by <name>." /
// "Back to <name>'s reply to <name>." on a reply (names counted separately), so
// the running total can't pass the cap once rendered.
const NARRATION_ALLOWANCE = 8
// A thread's closing "12 more replies in this thread weren't included."
const LEFT_OUT_ALLOWANCE = 9
// Opening, "Comments as of …", the count line and the ending.
const FRAME_ALLOWANCE = 60

export interface LwComment {
  _id: string
  parentCommentId: string | null
  baseScore: number | null
  // LessWrong's second vote, shown beside karma.
  extendedScore?: { agreement?: number | null; agreementVoteCount?: number | null } | null
  postedAt?: string | null
  deleted: boolean
  rejected?: boolean
  user: { displayName: string } | null
  contents: { html: string | null } | null
}

export interface LwPost {
  title: string
  comments: LwComment[]
}

export interface CommentsScript {
  episodeTitle: string
  script: string
  words: number
  // What the agent checks against AWC's own counts.
  quotations: number
  characters: number
  opening: string
  ending: string
}

const LW_GRAPHQL = 'https://www.lesswrong.com/graphql'
const LW_QUERY = `query($postId: String) {
  post(input: { selector: { _id: $postId } }) { result { title } }
  comments(input: { terms: { view: "postCommentsTop", postId: $postId, limit: 1000 } }) {
    results { _id parentCommentId baseScore extendedScore postedAt deleted rejected user { displayName } contents { html } }
  }
}`

export function postIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!['lesswrong.com', 'www.lesswrong.com'].includes(parsed.hostname)) return null
    return /^\/posts\/([^/]+)/.exec(parsed.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

export async function fetchLwPost(postId: string, fetchImpl: typeof fetch): Promise<LwPost> {
  const response = await fetchImpl(LW_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'reading-list-awc-agent' },
    body: JSON.stringify({ query: LW_QUERY, variables: { postId } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`LessWrong returned ${response.status}`)
  const body = (await response.json()) as {
    errors?: unknown[]
    data?: { post?: { result?: { title?: string } | null }; comments?: { results?: LwComment[] } }
  }
  const title = body.data?.post?.result?.title
  if (body.errors?.length || !title) throw new Error('LessWrong returned no post')
  return { title, comments: body.data?.comments?.results ?? [] }
}

export async function prepareCommentsScript(
  sourceUrl: string, fetchImpl: typeof fetch, now: Date = new Date(),
): Promise<{ ok: true; script: CommentsScript } | { ok: false; error: string }> {
  const postId = postIdFromUrl(sourceUrl)
  if (!postId) return { ok: false, error: 'could not read comments' }
  let post: LwPost
  try {
    post = await fetchLwPost(postId, fetchImpl)
  } catch {
    return { ok: false, error: 'could not read comments' }
  }
  const script = buildCommentsScript(post, now)
  return script ? { ok: true, script } : { ok: false, error: 'too few comments yet' }
}

type Segment = { kind: 'speech' | 'quote'; text: string }

function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S*[^\s.,;:!?)'"”]/g, '(link)')
    .replace(/["“”„‟]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function segmentsOf(html: string | null | undefined): Segment[] {
  if (!html) return []
  const fragment = JSDOM.fragment(html)
  const segments: Segment[] = []
  let buffer = ''
  const flush = (kind: Segment['kind']) => {
    const text = speakable(buffer)
    buffer = ''
    if (text) segments.push({ kind, text })
  }
  const visit = (node: Node, inQuote: boolean) => {
    if (node.nodeType === 3) {
      buffer += node.textContent ?? ''
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    // MathML keeps its lowercase tagName.
    const tag = element.tagName.toUpperCase()
    if (tag === 'STYLE' || tag === 'SCRIPT') return
    if (tag === 'PRE') { buffer += ' (code omitted) '; return }
    if (tag === 'IMG') { buffer += ' (image omitted) '; return }
    if (tag === 'MATH' || /math-tex|mjx/.test(element.getAttribute('class') ?? '') || tag.startsWith('MJX')) {
      buffer += ' (math omitted) '
      return
    }
    if (tag === 'BLOCKQUOTE' && !inQuote) {
      flush('speech')
      element.childNodes.forEach((child) => visit(child, true))
      flush('quote')
      return
    }
    if (/^(P|DIV|BR|H[1-6]|UL|OL|TR|TD|TH)$/.test(tag)) buffer += ' '
    element.childNodes.forEach((child) => visit(child, inQuote))
    // An empty item, or one that ended in a block quote, has nothing to finish.
    if (tag === 'LI' && buffer.trim()) buffer = `${buffer.trimEnd()}${/[.!?:;,]$/.test(buffer.trimEnd()) ? '' : '.'} `
    if (/^(P|DIV|H[1-6]|TD|TH)$/.test(tag)) buffer += ' '
  }
  fragment.childNodes.forEach((child) => visit(child, false))
  flush('speech')
  return segments
}

function displayName(comment: LwComment): string {
  const cleaned = (comment.user?.displayName ?? '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : 'A commenter'
}

const spokenNumber = (n: number) => (n < 0 ? `minus ${-n}` : `${n}`)
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

function relativeAge(postedAt: string | null | undefined, now: Date): string | null {
  const posted = postedAt ? Date.parse(postedAt) : NaN
  if (Number.isNaN(posted)) return null
  const minutes = Math.floor((now.getTime() - posted) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${plural(hours, 'hour')} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${plural(days, 'day')} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${plural(months, 'month')} ago`
  return `${plural(Math.max(1, Math.floor(days / 365)), 'year')} ago`
}

// Age, karma and agreement, in the order LessWrong shows them after the name:
// "2 days ago", "5 karma", "7 agreement".
function detailsOf(comment: LwComment, now: Date): string[] {
  const parts: string[] = []
  const age = relativeAge(comment.postedAt, now)
  if (age) parts.push(age)
  if (typeof comment.baseScore === 'number') parts.push(`${spokenNumber(comment.baseScore)} karma`)
  const agreement = comment.extendedScore?.agreement
  // A 0 nobody voted on says nothing; LessWrong leaves the axis blank too.
  const agreementVotes = comment.extendedScore?.agreementVoteCount
  if (typeof agreement === 'number' && agreementVotes !== 0) parts.push(`${spokenNumber(agreement)} agreement`)
  return parts
}

// "Raemon, replying to Maya, 2 days ago, 5 karma, 7 agreement, says" — the
// name opens the line, as on screen, and the verb leads into the quote.
type Lead = (verb: 'says' | 'quoting') => string
const speakerLead = (name: string, parts: string[]): Lead => (verb) =>
  (parts.length ? `${name}, ${parts.join(', ')}, ${verb}` : verb === 'says' ? `${name} says` : `${name}, quoting`)

function asOfLine(now: Date, timeZone: string | undefined): string {
  const when = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'long', timeZone,
  }).format(now).replace(/[\u202f\u00a0]/g, ' ').replace(/["#]/g, '')
  return `Comments as of ${when}.`
}

const wordsIn = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0)

// One comment's line, without the "Back to …" lead a jump adds. A comment that
// opens with a block quote reads "<lead>, quoting: … End quote. <Name> says: …".
function renderLine(name: string, lead: Lead, segments: Segment[]): { line: string; quotations: number } {
  const parts: string[] = []
  let spoken = false
  let quotations = 0
  segments.forEach(({ kind, text }, i) => {
    if (kind === 'quote') {
      parts.push(i === 0 ? `${lead('quoting')}: ${text} End quote.` : `Quoting: ${text} End quote.`)
      return
    }
    parts.push(spoken ? `${name} continues: "${text}"` : i === 0 ? `${lead('says')}: "${text}"` : `${name} says: "${text}"`)
    spoken = true
    quotations += 1
  })
  return { line: parts.join(' '), quotations }
}

interface Node_ {
  comment: LwComment
  name: string
  details: string[]
  segments: Segment[]
  gone: boolean
  score: number
  isRoot: boolean
}

const DELETED_LINE = 'A deleted comment.'
const DELETED_LABEL = 'a deleted comment'

export function buildCommentsScript(
  post: LwPost, now: Date = new Date(), timeZone?: string,
): CommentsScript | null {
  const byId = new Map<string, Node_>()
  const ids = new Set(post.comments.map((c) => c._id))
  for (const comment of post.comments) {
    const segments = comment.deleted || comment.rejected ? [] : segmentsOf(comment.contents?.html)
    byId.set(comment._id, {
      comment,
      name: displayName(comment),
      details: detailsOf(comment, now),
      segments,
      gone: segments.length === 0,
      score: comment.baseScore ?? 0,
      isRoot: !comment.parentCommentId || !ids.has(comment.parentCommentId),
    })
  }
  const nodes = [...byId.values()]
  const parentOf = (n: Node_) => (n.isRoot ? null : byId.get(n.comment.parentCommentId!) ?? null)
  // How a reply names the comment it answers.
  const labelOf = (n: Node_) => (n.gone ? DELETED_LABEL : n.name)
  const leadOf = (n: Node_) => {
    const parent = parentOf(n)
    return speakerLead(n.name, parent ? [`replying to ${labelOf(parent)}`, ...n.details] : n.details)
  }
  // Where a jump lands: the thread's top comment, or a reply named by who wrote it and whom it answered.
  // A root whose own parent is missing from the results isn't really the top.
  const jumpTo = (parent: Node_) => {
    const grandparent = parentOf(parent)
    const orphan = !grandparent && Boolean(parent.comment.parentCommentId)
    if (parent.gone) {
      if (grandparent) return `Back to the deleted reply to ${labelOf(grandparent)}. `
      return orphan ? 'Back to the deleted comment. ' : 'Back to the deleted top comment. '
    }
    if (grandparent) return `Back to ${parent.name}'s reply to ${labelOf(grandparent)}. `
    return orphan ? `Back to ${parent.name}'s comment. ` : `Back to the top comment, by ${parent.name}. `
  }
  // Every reply, kept or not: for selection, the walk and each thread's left-out count.
  const allChildren = new Map<string, Node_[]>()
  for (const n of nodes) {
    if (n.isRoot) continue
    const parentId = n.comment.parentCommentId!
    const siblings = allChildren.get(parentId)
    if (siblings) siblings.push(n)
    else allChildren.set(parentId, [n])
  }
  const costs = new Map<string, number>()
  const cost = (n: Node_) => {
    let words = costs.get(n.comment._id)
    if (words === undefined) {
      // A jump lead names the parent and the grandparent; NARRATION_ALLOWANCE
      // covers its fixed words and a root's "## Thread 12 of 56, 34 comments".
      const parent = parentOf(n)
      const grandparent = parent && parentOf(parent)
      words = (n.gone ? wordsIn(DELETED_LINE) : wordsIn(renderLine(n.name, leadOf(n), n.segments).line))
        + (parent ? wordsIn(labelOf(parent)) : 0)
        + (grandparent ? wordsIn(labelOf(grandparent)) : 0)
        + NARRATION_ALLOWANCE
        // Only a root with replies can end with a left-out line.
        + (n.isRoot && allChildren.has(n.comment._id) ? LEFT_OUT_ALLOWANCE : 0)
      costs.set(n.comment._id, words)
    }
    return words
  }

  // Highest score first, each with whatever ancestors it needs to make sense. A
  // comment that doesn't fit is skipped, and smaller ones can still take its room.
  const budget = MAX_WORDS - FRAME_ALLOWANCE - wordsIn(post.title)
  const kept = new Set<string>()
  let used = 0
  const candidates = nodes.filter((n) => !n.gone).sort((a, b) => b.score - a.score)
  for (const candidate of candidates) {
    const missing: Node_[] = []
    for (let n: Node_ | null = candidate; n && !kept.has(n.comment._id); n = parentOf(n)) missing.push(n)
    const extra = missing.reduce((sum, n) => sum + cost(n), 0)
    if (used + extra > budget) continue
    used += extra
    for (const n of missing) kept.add(n.comment._id)
  }

  const keptNodes = nodes.filter((n) => kept.has(n.comment._id))
  const spokenWords = keptNodes.reduce((sum, n) => sum + n.segments.reduce((s, seg) => s + wordsIn(seg.text), 0), 0)
  if (spokenWords < MIN_WORDS) return null

  const byScore = (a: Node_, b: Node_) => b.score - a.score
  const roots = keptNodes.filter((n) => n.isRoot).sort(byScore)

  const blocks: string[] = []
  const speakers = new Set<string>()
  let quotations = 0
  let previousId: string | null = null
  const walk = (n: Node_) => {
    const parent = parentOf(n)
    const lead = parent && parent.comment._id !== previousId ? jumpTo(parent) : ''
    if (n.gone) {
      blocks.push(`${lead}${DELETED_LINE}`)
    } else {
      const rendered = renderLine(n.name, leadOf(n), n.segments)
      blocks.push(`${lead}${rendered.line}`)
      quotations += rendered.quotations
      if (rendered.quotations > 0) speakers.add(n.name)
    }
    previousId = n.comment._id
    ;(allChildren.get(n.comment._id) ?? []).filter((c) => kept.has(c.comment._id)).sort(byScore).forEach(walk)
  }
  const droppedUnder = (n: Node_): number =>
    (allChildren.get(n.comment._id) ?? []).reduce(
      (sum, child) => sum + (!child.gone && !kept.has(child.comment._id) ? 1 : 0) + droppedUnder(child), 0)
  const spokenIn = (n: Node_): number =>
    (n.gone ? 0 : 1) + (allChildren.get(n.comment._id) ?? [])
      .filter((c) => kept.has(c.comment._id)).reduce((sum, c) => sum + spokenIn(c), 0)
  roots.forEach((root, i) => {
    const size = spokenIn(root)
    blocks.push(`## Thread ${i + 1} of ${roots.length}, ${size} ${size === 1 ? 'comment' : 'comments'}`)
    previousId = null
    walk(root)
    const dropped = droppedUnder(root)
    if (dropped > 0) {
      blocks.push(dropped === 1
        ? `1 more reply in this thread wasn't included.`
        : `${dropped} more replies in this thread weren't included.`)
    }
  })

  const total = nodes.filter((n) => !n.gone).length
  const keptCount = keptNodes.filter((n) => !n.gone).length
  const leftOut = total - keptCount
  const bodyWords = blocks.reduce((sum, block) => sum + wordsIn(block), 0)
  const minutes = Math.max(1, Math.round(bodyWords / WORDS_PER_MINUTE))
  const title = speakable(post.title)
  const opening = `Comments on: ${title}${/[.!?]$/.test(title) ? '' : '.'}`
  const ending = `That's the end of the comments.${leftOut > 0 ? ` Left out for length: ${leftOut} ${leftOut === 1 ? 'comment' : 'comments'}.` : ''}`
  const script = [
    opening,
    asOfLine(now, timeZone),
    `${keptCount} of ${total} ${total === 1 ? 'comment' : 'comments'}, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    ...blocks,
    ending,
  ].join('\n\n') + '\n'

  return {
    episodeTitle: `Comments: ${post.title.trim()}`,
    script,
    words: wordsIn(script),
    quotations,
    characters: speakers.size,
    opening,
    ending,
  }
}
