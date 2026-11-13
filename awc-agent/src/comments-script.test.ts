// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  MAX_WORDS, buildCommentsScript, fetchLwPost, postIdFromUrl, prepareCommentsScript,
  type LwComment,
} from './comments-script'

// Shaped like LessWrong's GraphQL response; the text is written for these tests.
function comment(id: string, name: string | null, html: string | null, over: Partial<LwComment> = {}): LwComment {
  return {
    _id: id, parentCommentId: null, baseScore: 10, deleted: false,
    user: name === null ? null : { displayName: name },
    contents: html === null ? null : { html },
    ...over,
  }
}
const say = (words: string) => `<p><span>${words}</span></p>`
const filler = (n: number, word = 'word') => Array.from({ length: n }, () => word).join(' ')
const TITLE = 'A Post'
const NOW = new Date('2026-11-07T15:02:00Z')
const TZ = 'America/Chicago'
const AS_OF = 'Comments as of Saturday, November 7, 2026 at 9:02 AM Central Standard Time.'
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const build = (comments: LwComment[]) => buildCommentsScript({ title: TITLE, comments }, NOW, TZ)
// Long enough to clear the minimum in tests about something else.
const padding = (id = 'pad') => comment(id, 'Padder', say(filler(250)), { baseScore: 1000 })

describe('buildCommentsScript narration', () => {
  it('produces the agreed script shape', () => {
    const s = build([
      comment('a', 'dvd', say('First point.'), { baseScore: 80, extendedScore: { agreement: 12 }, postedAt: ago(2 * DAY) }),
      comment('b', 'Maya', say('A reply.'), { parentCommentId: 'a', baseScore: 40, extendedScore: { agreement: -3 }, postedAt: ago(DAY) }),
      comment('c', 'dvd', say('Back at you.'), { parentCommentId: 'b', baseScore: 30, extendedScore: { agreement: 0 }, postedAt: ago(5 * HOUR) }),
      comment('d', 'Sam', say('Another reply.'), { parentCommentId: 'a', baseScore: 20, extendedScore: { agreement: 4 }, postedAt: ago(40 * DAY) }),
      comment('e', 'Priya', say(filler(220)), { baseScore: 5, extendedScore: { agreement: 1 }, postedAt: ago(3 * MINUTE) }),
      comment('low', 'Nobody', say('Low but read.'), { baseScore: 2, extendedScore: { agreement: 0 }, postedAt: ago(400 * DAY) }),
    ])!
    const lines = s.script.split('\n').filter(Boolean)
    expect(lines[0]).toBe(`Comments on: ${TITLE}.`)
    expect(lines[1]).toBe(AS_OF)
    expect(lines[2]).toMatch(/^6 of 6 comments, about \d+ minutes?\.$/)
    expect(lines[3]).toBe('## Thread 1 of 3, 4 comments')
    expect(lines[4]).toBe('dvd, 2 days ago, 80 karma, 12 agreement, says: "First point."')
    expect(lines[5]).toBe('Maya, replying to dvd, 1 day ago, 40 karma, minus 3 agreement, says: "A reply."')
    expect(lines[6]).toBe('dvd, replying to Maya, 5 hours ago, 30 karma, 0 agreement, says: "Back at you."')
    expect(lines[7]).toBe('Back to the top comment, by dvd. Sam, replying to dvd, 1 month ago, 20 karma, 4 agreement, says: "Another reply."')
    expect(lines[8]).toBe('## Thread 2 of 3, 1 comment')
    expect(lines[9].startsWith('Priya, 3 minutes ago, 5 karma, 1 agreement, says: "')).toBe(true)
    expect(lines[10]).toBe('## Thread 3 of 3, 1 comment')
    expect(lines[11]).toBe('Nobody, 1 year ago, 2 karma, 0 agreement, says: "Low but read."')
    expect(lines.at(-1)).toBe(`That's the end of the comments.`)
  })
  it('names where a jump lands', () => {
    const s = build([
      comment('a', 'dvd', say(filler(220)), { baseScore: 90 }),
      comment('b', 'Maya', say('One.'), { parentCommentId: 'a', baseScore: 50 }),
      comment('c', 'dvd', say('Two.'), { parentCommentId: 'b', baseScore: 40 }),
      comment('d', 'Sam', say('Three.'), { parentCommentId: 'b', baseScore: 30 }),
      comment('e', 'Priya', say('Four.'), { parentCommentId: 'a', baseScore: 20 }),
    ])!.script
    expect(s).toContain(`Back to Maya's reply to dvd. Sam, replying to Maya, 30 karma, says: "Three."`)
    expect(s).toContain(`Back to the top comment, by dvd. Priya, replying to dvd, 20 karma, says: "Four."`)
  })
  it('names a jump back to a reply whose parent was deleted', () => {
    const s = build([padding(),
      comment('p', null, null, { deleted: true, baseScore: 0 }),
      comment('b', 'Maya', say('One.'), { parentCommentId: 'p', baseScore: 50 }),
      comment('c', 'dvd', say('Two.'), { parentCommentId: 'b', baseScore: 40 }),
      comment('d', 'Sam', say('Three.'), { parentCommentId: 'b', baseScore: 30 }),
    ])!.script
    expect(s).toContain(`Back to Maya's reply to a deleted comment. Sam, replying to Maya, 30 karma, says: "Three."`)
  })
  it('gives each thread heading its size, counting only kept, spoken comments', () => {
    const s = build([padding(),
      comment('p', null, null, { deleted: true, baseScore: 0 }),
      comment('b', 'Maya', say('One.'), { parentCommentId: 'p', baseScore: 50 }),
      comment('c', 'dvd', say('Two.'), { parentCommentId: 'b', baseScore: 40 }),
    ])!.script.split('\n').filter((l) => l.startsWith('## '))
    expect(s).toEqual(['## Thread 1 of 2, 1 comment', '## Thread 2 of 2, 2 comments'])
  })
  it('keeps a capped script of long names and deep threads within the cap', () => {
    // Side replies outscore the chain, so the walk reads them first and jumps back.
    const longName = (i: number) => `n${i} ${filler(19, 'x')}`.slice(0, 40)
    const all: LwComment[] = []
    for (let t = 0; t < 30; t += 1) {
      all.push(comment(`t${t}`, longName(t), say(filler(40)), { baseScore: 500 - t, postedAt: ago(DAY), extendedScore: { agreement: -12 } }))
      for (let d = 1; d < 12; d += 1) {
        all.push(comment(`t${t}d${d}`, longName(d), say(filler(40)),
          { parentCommentId: d === 1 ? `t${t}` : `t${t}d${d - 1}`, baseScore: 400 - t - d, postedAt: ago(DAY), extendedScore: { agreement: -12 } }))
        all.push(comment(`t${t}s${d}`, longName(d + 50), say(filler(40)),
          { parentCommentId: d === 1 ? `t${t}` : `t${t}d${d - 1}`, baseScore: 450 - t - d, postedAt: ago(DAY), extendedScore: { agreement: -12 } }))
      }
    }
    const s = build(all)!
    expect(s.script).toContain('Left out for length')
    expect(s.script).toMatch(/Back to n\d+ x x[^.]*'s reply to n\d+/)
    expect(s.words).toBeLessThanOrEqual(MAX_WORDS)
  })
  it('titles the episode and reports what the agent must verify', () => {
    const s = build([padding(), comment('b', 'Maya', say('Two.'), { parentCommentId: 'pad' })])!
    expect(s.episodeTitle).toBe(`Comments: ${TITLE}`)
    expect(s.quotations).toBe(2)
    expect(s.characters).toBe(2)
    expect(s.words).toBe(s.script.trim().split(/\s+/).length)
    expect(s.opening).toBe(`Comments on: ${TITLE}.`)
    expect(s.ending).toBe(`That's the end of the comments.`)
  })
  it('leaves out the left-out clause when nothing was dropped', () => {
    expect(build([padding()])!.script.trim().endsWith(`That's the end of the comments.`)).toBe(true)
  })
  it('counts one character per commenter however often they speak', () => {
    const s = build([padding(), comment('b', 'Padder', say('Again.'), { parentCommentId: 'pad' })])!
    expect(s.quotations).toBe(2)
    expect(s.characters).toBe(1)
  })
  it('orders threads by root score and siblings by score', () => {
    const s = build([
      comment('low', 'Low', say(filler(120)), { baseScore: 4 }),
      comment('top', 'Top', say(filler(120)), { baseScore: 90 }),
      comment('r1', 'Second', say('x'), { parentCommentId: 'top', baseScore: 5 }),
      comment('r2', 'First', say('y'), { parentCommentId: 'top', baseScore: 50 }),
    ])!.script
    expect(s.indexOf('Top, 90 karma, says')).toBeLessThan(s.indexOf('Low, 4 karma, says'))
    expect(s.indexOf('First, replying to Top')).toBeLessThan(s.indexOf('Second, replying to Top'))
  })
})

describe('buildCommentsScript comment details', () => {
  const lineFor = (over: Partial<LwComment>) =>
    build([padding(), comment('b', 'dvd', say('Hi.'), { parentCommentId: 'pad', ...over })])!.script
      .split('\n').find((l) => l.startsWith('dvd'))!
  it('reads name first, then whom it answers, age, karma and agreement, as LessWrong shows them', () => {
    expect(lineFor({ baseScore: 91, extendedScore: { agreement: 35 }, postedAt: ago(2 * DAY) }))
      .toBe('dvd, replying to Padder, 2 days ago, 91 karma, 35 agreement, says: "Hi."')
    const root = build([comment('r', 'Raemon', say(filler(220)), { baseScore: 5, extendedScore: { agreement: 7 }, postedAt: ago(2 * DAY) })])!
    expect(root.script).toContain('Raemon, 2 days ago, 5 karma, 7 agreement, says: "word')
  })
  it('reads negative scores as minus', () => {
    expect(lineFor({ baseScore: -3, extendedScore: { agreement: -4 } })).toBe('dvd, replying to Padder, minus 3 karma, minus 4 agreement, says: "Hi."')
  })
  it('leaves out agreement when nobody voted on it', () => {
    expect(lineFor({ extendedScore: { agreement: 0, agreementVoteCount: 0 } })).toBe('dvd, replying to Padder, 10 karma, says: "Hi."')
    expect(lineFor({ extendedScore: { agreement: 0, agreementVoteCount: 3 } })).toBe('dvd, replying to Padder, 10 karma, 0 agreement, says: "Hi."')
  })
  it('omits the parts it has no data for', () => {
    expect(lineFor({ extendedScore: null, postedAt: null })).toBe('dvd, replying to Padder, 10 karma, says: "Hi."')
    expect(lineFor({ baseScore: null, extendedScore: {}, postedAt: 'not a date' })).toBe('dvd, replying to Padder, says: "Hi."')
    const bare = build([comment('r', 'Raemon', say(filler(220)), { baseScore: null })])!
    expect(bare.script).toContain('Raemon says: "word')
  })
  it.each([
    [30_000, 'just now'],
    [-HOUR, 'just now'],
    [MINUTE, '1 minute ago'],
    [59 * MINUTE, '59 minutes ago'],
    [HOUR, '1 hour ago'],
    [23 * HOUR, '23 hours ago'],
    [DAY, '1 day ago'],
    [29 * DAY, '29 days ago'],
    [30 * DAY, '1 month ago'],
    [359 * DAY, '11 months ago'],
    [360 * DAY, '1 year ago'],
    [365 * DAY, '1 year ago'],
    [1100 * DAY, '3 years ago'],
  ])('reads an age of %i ms as %s', (ms, words) => {
    expect(lineFor({ baseScore: null, postedAt: ago(ms) })).toBe(`dvd, replying to Padder, ${words}, says: "Hi."`)
  })
  it('puts the speaker after a Back to lead', () => {
    const s = build([padding(),
      comment('b', 'Maya', say('One.'), { parentCommentId: 'pad', baseScore: 50 }),
      comment('c', 'Sam', say('Two.'), { parentCommentId: 'pad', baseScore: 40, extendedScore: { agreement: 2 } }),
    ])!.script
    expect(s).toContain(`Back to the top comment, by Padder. Sam, replying to Padder, 40 karma, 2 agreement, says: "Two."`)
  })
  it('says when the comments were fetched, with no quote marks or odd spaces', () => {
    const s = build([padding()])!
    expect(s.script.split('\n')[2]).toBe(AS_OF)
    expect(s.script).not.toMatch(/[\u202f\u00a0]/)
    expect(s.opening).toBe(`Comments on: ${TITLE}.`)
    expect(s.script.split('"').length - 1).toBe(s.quotations * 2)
  })
})

describe('buildCommentsScript text', () => {
  it('turns every inner double quote into a single quote, so AWC finds one line per comment', () => {
    const s = build([padding(), comment('b', 'Maya', say('He said "yes" and “no”.'), { parentCommentId: 'pad' })])!
    expect(s.script).toContain(`Maya, replying to Padder, 10 karma, says: "He said 'yes' and 'no'."`)
    expect(s.script.split('"').length - 1).toBe(s.quotations * 2)
  })
  it('has the narrator read block quotes and the speaker resume after them', () => {
    const s = build([padding(), comment('b', 'Maya',
      `<p>Before.</p><blockquote><p><span>Quoted "text".</span></p></blockquote><p>After.</p>`, { parentCommentId: 'pad' })])!
    expect(s.script).toContain(`Maya, replying to Padder, 10 karma, says: "Before." Quoting: Quoted 'text'. End quote. Maya continues: "After."`)
    expect(s.quotations).toBe(3)
  })
  it('has a comment that opens with a block quote read as quoting, then says', () => {
    const s = build([padding(), comment('b', 'Maya', `<blockquote><p>Theirs.</p></blockquote><p>Mine.</p>`, { parentCommentId: 'pad' })])!
    expect(s.script).toContain('Maya, replying to Padder, 10 karma, quoting: Theirs. End quote. Maya says: "Mine."')
    expect(s.script).not.toContain('says.')
    expect(s.script.split('"').length - 1).toBe(s.quotations * 2)
  })
  it('counts no quotation for a comment that is only a block quote', () => {
    const s = build([padding(), comment('b', 'Maya', `<blockquote><p>Just this.</p></blockquote>`, { parentCommentId: 'pad' })])!
    expect(s.script).toContain('Maya, replying to Padder, 10 karma, quoting: Just this. End quote.')
    expect(s.quotations).toBe(1)
    expect(s.characters).toBe(1)
    expect(s.script.split('"').length - 1).toBe(s.quotations * 2)
  })
  it('keeps link text, drops URLs and names what it omits', () => {
    const s = build([padding(), comment('b', 'Maya',
      `<p>See <a href="https://x.com/a">this post</a> and https://y.com/b?c=1 too.</p><pre><code>let a</code></pre><p><img src="i.png"/></p><p><span class="math-tex">x^2</span></p>`,
      { parentCommentId: 'pad' })])!.script
    expect(s).toContain('See this post and (link) too.')
    expect(s).toContain('(code omitted)')
    expect(s).toContain('(image omitted)')
    expect(s).toContain('(math omitted)')
    expect(s).not.toContain('x^2')
    expect(s).not.toContain('https://')
  })
  it('never reads embedded CSS or scripts aloud', () => {
    const s = build([padding(), comment('b', 'Maya',
      `<style>mjx-container { line-height: 0; }</style><p>Words.</p><script>alert(1)</script>`, { parentCommentId: 'pad' })])!.script
    expect(s).toContain('Maya, replying to Padder, 10 karma, says: "Words."')
    expect(s).not.toContain('mjx-container')
    expect(s).not.toContain('alert')
  })
  it('omits MathML, whose tag name is lowercase', () => {
    const s = build([padding(), comment('b', 'Maya', `<p>x<math><mi>y</mi></math>z</p>`, { parentCommentId: 'pad' })])!.script
    expect(s).toContain('x (math omitted) z')
  })
  it('separates table cells', () => {
    const s = build([padding(), comment('b', 'Maya', `<table><tr><td>one</td><td>two</td></tr><tr><td>three</td></tr></table>`, { parentCommentId: 'pad' })])!.script
    expect(s).toContain('Maya, replying to Padder, 10 karma, says: "one two three"')
  })
  it('adds no spoken line for an empty list item or one ending in a block quote', () => {
    const s = build([padding(), comment('b', 'Maya', `<ul><li>item<blockquote>q</blockquote></li><li></li></ul>`, { parentCommentId: 'pad' })])!
    expect(s.script).not.toContain('continues')
    expect(s.script).toContain('Quoting: q End quote.')
    expect(s.quotations).toBe(2)
    expect(s.script.split('"').length - 1).toBe(4)
  })
  it('keeps each comment on one line and makes list items sentences', () => {
    const s = build([padding(), comment('b', 'Maya', `<p>Two:</p><ul><li>one</li><li>two</li></ul>`, { parentCommentId: 'pad' })])!.script
    expect(s).toContain('Maya, replying to Padder, 10 karma, says: "Two: one. two."')
  })
  it('limits display names to safe characters', () => {
    const s = build([padding(),
      comment('b', 'Ann "x" #1 <b>', say('A.'), { parentCommentId: 'pad' }),
      comment('c', '!!!', say('B.'), { parentCommentId: 'pad', baseScore: 9 }),
      comment('d', null, say('C.'), { parentCommentId: 'pad', baseScore: 8 }),
      comment('e', 'José_R-2.0', say('D.'), { parentCommentId: 'pad', baseScore: 7 }),
    ])!.script
    expect(s).toContain('Ann x 1 b, replying to Padder, 10 karma, says:')
    expect(s).toContain('A commenter, replying to Padder, 9 karma, says: "B."')
    expect(s).toContain('A commenter, replying to Padder, 8 karma, says: "C."')
    expect(s).toContain('José_R-2.0, replying to Padder, 7 karma, says:')
  })
})

describe('buildCommentsScript selection', () => {
  it('keeps the low-scoring parent of a high-scoring reply', () => {
    const s = build([padding(),
      comment('p', 'Parent', say('Weak.'), { baseScore: 0 }),
      comment('r', 'Reply', say('Strong.'), { parentCommentId: 'p', baseScore: 50 }),
    ])!.script
    expect(s).toContain('Parent, 0 karma, says: "Weak."')
    expect(s).toContain('Reply, replying to Parent, 50 karma, says: "Strong."')
  })
  it('renders a deleted ancestor as a narrator line', () => {
    const s = build([padding(),
      comment('p', null, null, { baseScore: 0, deleted: true }),
      comment('r', 'Reply', say('One.'), { parentCommentId: 'p', baseScore: 50 }),
      comment('r2', 'Other', say('Two.'), { parentCommentId: 'p', baseScore: 40 }),
    ])!.script
    expect(s).toContain('A deleted comment.')
    expect(s).toContain('Reply, replying to a deleted comment, 50 karma, says: "One."')
    expect(s).toContain('Back to the deleted top comment. Other, replying to a deleted comment, 40 karma, says: "Two."')
  })
  it('drops deleted and rejected comments with no kept replies, and does not count them as left out', () => {
    const s = build([padding(),
      comment('d', null, null, { baseScore: 50, deleted: true }),
      comment('x', 'Spam', say('Rejected.'), { baseScore: 50, rejected: true }),
      comment('l', 'Low', say('Low.'), { baseScore: 1 }),
    ])!.script
    expect(s).toContain('2 of 2 comments')
    expect(s).not.toContain('A deleted comment.')
    expect(s).not.toContain('Rejected.')
    expect(s).not.toContain('Left out')
  })
  it('stays within the cap, keeping the highest-scoring comments', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      comment(`c${i}`, `Person${i}`, say(filler(500, `w${i}`)), { baseScore: 100 - i }))
    const s = build(many)!
    expect(s.words).toBeLessThanOrEqual(MAX_WORDS)
    expect(s.words).toBeGreaterThan(MAX_WORDS * 0.9)
    expect(s.script).toContain('Person0, 100 karma, says')
    expect(s.script).not.toContain('Person59,')
    expect(s.script).toMatch(/Left out for length: \d+ comments\.\n$/)
  })
  it('skips a comment bigger than the remaining budget and keeps filling with smaller ones', () => {
    const s = build([
      comment('huge', 'Huge', say(filler(MAX_WORDS + 100)), { baseScore: 90 }),
      comment('small', 'Small', say(filler(300)), { baseScore: 5 }),
    ])!
    expect(s.script).not.toContain('Huge,')
    expect(s.script).toContain('Small, 5 karma, says')
    expect(s.words).toBeLessThanOrEqual(MAX_WORDS)
  })
  it('reads low and negative karma comments when everything fits', () => {
    const s = build([
      comment('a', 'Neg', say(filler(150)), { baseScore: -4 }),
      comment('b', 'Zero', say(filler(100)), { baseScore: 0 }),
    ])!.script
    expect(s).toContain('Neg, minus 4 karma, says:')
    expect(s).toContain('Zero, 0 karma, says:')
    expect(s).toContain('2 of 2 comments')
  })
  it('says how many replies a thread lost to the cap, and stays within it', () => {
    const replies = Array.from({ length: 40 }, (_, i) =>
      comment(`r${i}`, `R${i}`, say(filler(500, `w${i}`)), { parentCommentId: 'root', baseScore: 50 - i }))
    const s = build([comment('root', 'Root', say(filler(300)), { baseScore: 100 }), ...replies])!
    const lines = s.script.split('\n').filter(Boolean)
    const kept = replies.filter((r) => s.script.includes(`${r.user!.displayName}, replying to Root`)).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(40)
    expect(lines.at(-2)).toBe(`${40 - kept} more replies in this thread weren't included.`)
    expect(s.words).toBeLessThanOrEqual(MAX_WORDS)
  })
  it('reserves no left-out room on roots without replies', () => {
    // Each root costs 243 budgeted words (231 spoken, name, verb, details and
    // narration), so 59 fit the 14,338-word budget only if no root also holds
    // back 9 words for a left-out line it can't have.
    const roots = Array.from({ length: 60 }, (_, i) =>
      comment(`c${i}`, `P${i}`, say(filler(231, `w${i}`)), { baseScore: 100 - i }))
    const s = build(roots)!
    expect(s.script).toContain('P58, 42 karma, says')
    expect(s.words).toBeLessThanOrEqual(MAX_WORDS)
  })
  it('uses the singular for one left-out reply', () => {
    const s = build([
      comment('root', 'Root', say(filler(300)), { baseScore: 100 }),
      comment('big', 'Big', say(filler(MAX_WORDS)), { parentCommentId: 'root', baseScore: 50 }),
      comment('ok', 'Ok', say('Fine.'), { parentCommentId: 'root', baseScore: 40 }),
    ])!
    expect(s.script).toContain(`Ok, replying to Root, 40 karma, says: "Fine."\n\n1 more reply in this thread wasn't included.`)
  })
  it('adds no left-out line to a complete thread', () => {
    const s = build([padding(), comment('b', 'Maya', say('Two.'), { parentCommentId: 'pad' })])!
    expect(s.script).not.toContain('in this thread')
  })
  it('tells two deleted comments apart when jumping back to one', () => {
    const s = build([padding(),
      comment('m', 'Maya', say('Top.'), { baseScore: 60 }),
      comment('p', null, null, { parentCommentId: 'm', deleted: true }),
      comment('c', 'dvd', say('Two.'), { parentCommentId: 'p', baseScore: 40 }),
      comment('d', 'Sam', say('Three.'), { parentCommentId: 'c', baseScore: 35 }),
      comment('e', 'Priya', say('Four.'), { parentCommentId: 'p', baseScore: 30 }),
    ])!.script
    expect(s).toContain(`Back to the deleted reply to Maya. Priya, replying to a deleted comment, 30 karma, says: "Four."`)
  })
  it('does not call a reply whose parent is missing the top comment', () => {
    const s = build([padding(),
      comment('o', 'Orphan', say('Hi.'), { parentCommentId: 'gone', baseScore: 60 }),
      comment('c', 'dvd', say('Two.'), { parentCommentId: 'o', baseScore: 40 }),
      comment('d', 'Sam', say('Three.'), { parentCommentId: 'c', baseScore: 35 }),
      comment('e', 'Priya', say('Four.'), { parentCommentId: 'o', baseScore: 30 }),
    ])!.script
    expect(s).toContain(`Back to Orphan's comment. Priya, replying to Orphan, 30 karma, says: "Four."`)
    expect(s).not.toContain('top comment, by Orphan')
  })
  it('treats a reply whose parent is missing from the results as a thread of its own', () => {
    const s = build([padding(), comment('r', 'Orphan', say('Hi.'), { parentCommentId: 'gone' })])!
    expect(s.script).toContain('Orphan, 10 karma, says: "Hi."')
  })
  it('returns null under the minimum, counting only what survives the filter', () => {
    expect(build([comment('a', 'A', say('Short.'))])).toBeNull()
    expect(build([comment('a', 'A', null), comment('b', 'B', say(filler(150)), { deleted: true })])).toBeNull()
    expect(build([])).toBeNull()
  })
})

describe('postIdFromUrl', () => {
  it.each([
    ['https://www.lesswrong.com/posts/abc123/some-title#comments', 'abc123'],
    ['https://lesswrong.com/posts/abc123', 'abc123'],
  ])('reads %s', (url, id) => {
    expect(postIdFromUrl(url)).toBe(id)
  })
  it.each(['https://www.lesswrong.com/users/x', 'https://ex.com/posts/abc/t', 'not a url'])('rejects %s', (url) => {
    expect(postIdFromUrl(url)).toBeNull()
  })
})

const graphql = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 503, json: async () => body }) as unknown as typeof fetch

describe('fetchLwPost', () => {
  it('posts one GraphQL query and maps the title and comments', async () => {
    const fetchImpl = graphql({ data: { post: { result: { title: 'T' } }, comments: { results: [comment('a', 'A', say('x'))] } } })
    const post = await fetchLwPost('abc123', fetchImpl)
    expect(post.title).toBe('T')
    expect(post.comments).toHaveLength(1)
    expect(JSON.parse((vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit).body as string).query)
      .toMatch(/postedAt[\s\S]*extendedScore|extendedScore[\s\S]*postedAt/)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]
    expect(url).toBe('https://www.lesswrong.com/graphql')
    expect(JSON.parse((init as RequestInit).body as string).variables).toEqual({ postId: 'abc123' })
  })
  it('throws on an HTTP failure or GraphQL errors', async () => {
    await expect(fetchLwPost('a', graphql({}, false))).rejects.toThrow()
    await expect(fetchLwPost('a', graphql({ errors: [{ message: 'no' }] }))).rejects.toThrow()
    await expect(fetchLwPost('a', graphql({ data: { post: { result: null }, comments: { results: [] } } }))).rejects.toThrow()
  })
})

describe('prepareCommentsScript', () => {
  const url = 'https://www.lesswrong.com/posts/abc123/t#comments'
  it('returns the script', async () => {
    const fetchImpl = graphql({ data: { post: { result: { title: 'T' } }, comments: { results: [padding()] } } })
    const r = await prepareCommentsScript(url, fetchImpl)
    expect(r.ok && r.script.episodeTitle).toBe('Comments: T')
  })
  it('reports too few comments, a read failure and a bad URL as fixed strings', async () => {
    const few = graphql({ data: { post: { result: { title: 'T' } }, comments: { results: [] } } })
    expect(await prepareCommentsScript(url, few)).toEqual({ ok: false, error: 'too few comments yet' })
    expect(await prepareCommentsScript(url, graphql({}, false))).toEqual({ ok: false, error: 'could not read comments' })
    expect(await prepareCommentsScript('https://ex.com/x', few)).toEqual({ ok: false, error: 'could not read comments' })
  })
})
