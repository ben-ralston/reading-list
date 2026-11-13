import { describe, it, expect } from 'vitest'
import { normalizeTitle, levenshteinDistance, titlesAreFuzzyMatch, fuzzyTitleScore, baseTitle } from './normalize-title'

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe('normalizeTitle', () => {
  describe('guard clauses', () => {
    it('returns empty string for null/undefined/empty', () => {
      expect(normalizeTitle(null)).toBe('')
      expect(normalizeTitle(undefined)).toBe('')
      expect(normalizeTitle('')).toBe('')
      expect(normalizeTitle('   ')).toBe('')
    })
  })

  describe('surrounding quotes', () => {
    it('strips double quotes', () => {
      expect(normalizeTitle('"Good Article"')).toBe('good article')
    })

    it('strips single quotes', () => {
      expect(normalizeTitle("'Good Article'")).toBe('good article')
    })

    it('strips curly double quotes', () => {
      expect(normalizeTitle('\u201CGood Article\u201D')).toBe('good article')
    })

    it('strips curly single quotes', () => {
      expect(normalizeTitle('\u2018Good Article\u2019')).toBe('good article')
    })

    it('does not strip mismatched quotes', () => {
      expect(normalizeTitle('"Good Article\'')).toBe('"good article\'')
    })

    it('does not strip internal quotes', () => {
      expect(normalizeTitle('The "Real" Story')).toBe('the "real" story')
    })

    it('only strips outermost pair', () => {
      expect(normalizeTitle('"\'inner\'"')).toBe("'inner'")
    })

    it('handles title that is just quotes', () => {
      expect(normalizeTitle('""')).toBe('')
    })
  })

  describe('trailing author stripping', () => {
    it('strips " by Author" suffix', () => {
      expect(normalizeTitle('Good Article by John Smith', 'John Smith')).toBe('good article')
    })

    it('strips " - Author" suffix', () => {
      expect(normalizeTitle('Good Article - John Smith', 'John Smith')).toBe('good article')
    })

    it('strips " — Author" (em dash) suffix', () => {
      expect(normalizeTitle('Good Article \u2014 John Smith', 'John Smith')).toBe('good article')
    })

    it('strips " – Author" (en dash) suffix', () => {
      expect(normalizeTitle('Good Article \u2013 John Smith', 'John Smith')).toBe('good article')
    })

    it('is case-insensitive for author matching', () => {
      expect(normalizeTitle('Good Article by john smith', 'John Smith')).toBe('good article')
    })

    it('does not strip partial author matches', () => {
      expect(normalizeTitle('Good Article by John', 'John Smith')).toBe('good article by john')
    })

    it('handles no author param', () => {
      expect(normalizeTitle('Good Article by John Smith')).toBe('good article by john smith')
    })
  })

  describe('unicode punctuation', () => {
    it('normalizes curly quotes to straight', () => {
      expect(normalizeTitle('The \u201CArt\u201D of \u2018War\u2019')).toBe('the "art" of \'war\'')
    })

    it('normalizes em/en dashes to hyphens', () => {
      expect(normalizeTitle('AI Safety\u2014A Primer')).toBe('ai safety-a primer')
      expect(normalizeTitle('AI Safety\u2013A Primer')).toBe('ai safety-a primer')
    })

    it('normalizes ellipsis to three dots', () => {
      expect(normalizeTitle('Wait But Why\u2026')).toBe('wait but why...')
    })

    it('normalizes non-breaking spaces', () => {
      expect(normalizeTitle('hello\u00A0world')).toBe('hello world')
    })

    it('removes zero-width characters', () => {
      expect(normalizeTitle('hello\u200Bworld')).toBe('helloworld')
      expect(normalizeTitle('test\uFEFFvalue')).toBe('testvalue')
    })
  })

  describe('whitespace and case', () => {
    it('collapses multiple spaces', () => {
      expect(normalizeTitle('hello   world')).toBe('hello world')
    })

    it('trims and lowercases', () => {
      expect(normalizeTitle('  HELLO World  ')).toBe('hello world')
    })
  })

  describe('quoted attribution stripping', () => {
    it('strips "Title" by Author pattern', () => {
      expect(normalizeTitle('"How do we safely defer to AIs?" by Ryan Greenblatt', 'Redwood Research Blog')).toBe(
        'how do we safely defer to ais?'
      )
    })

    it('strips pattern with curly quotes', () => {
      expect(normalizeTitle('\u201CHow do we safely defer to AIs?\u201D by Ryan Greenblatt', 'Redwood Research Blog')).toBe(
        'how do we safely defer to ais?'
      )
    })

    it('handles nested quotes in title', () => {
      expect(normalizeTitle('"Distinguish between inference scaling and "larger tasks use more compute"" by Ryan Greenblatt', 'Redwood Research Blog')).toBe(
        'distinguish between inference scaling and "larger tasks use more compute"'
      )
    })

    it('does not strip when no by-attribution after quote', () => {
      expect(normalizeTitle('"Just a Quoted Title"')).toBe('just a quoted title')
    })

    it('does not strip when by is part of inner title', () => {
      expect(normalizeTitle('Stand by Me')).toBe('stand by me')
    })

    it('prefers known author stripping over pattern', () => {
      // When the author matches, trailing author stripping handles it
      // then surrounding quotes handles the rest
      expect(normalizeTitle('"Good Article" by John Smith', 'John Smith')).toBe('good article')
    })
  })

  describe('combined real-world examples', () => {
    it('handles quoted article with author', () => {
      expect(normalizeTitle('"good article abt dogs" by john', 'john')).toBe(
        'good article abt dogs'
      )
    })

    it('handles curly-quoted title', () => {
      expect(normalizeTitle('\u201CThe Art of War\u201D')).toBe('the art of war')
    })

    it('handles em dash title', () => {
      expect(normalizeTitle('AI Safety\u2014A Primer')).toBe('ai safety-a primer')
    })

    it('handles ellipsis title', () => {
      expect(normalizeTitle('Wait But Why\u2026')).toBe('wait but why...')
    })

    it('matches titles differing only in quote style', () => {
      const a = normalizeTitle('\u201CThe Great Stagnation\u201D')
      const b = normalizeTitle('"The Great Stagnation"')
      expect(a).toBe(b)
    })

    it('matches titles differing in dash style', () => {
      const a = normalizeTitle('AI \u2014 The Next Frontier')
      const b = normalizeTitle('AI - The Next Frontier')
      expect(a).toBe(b)
    })

    it('matches Spotify "Title" by Author vs plain title across aliases', () => {
      // Spotify: author = Redwood Research Blog, title includes individual author
      const spotify = normalizeTitle(
        '"How do we (more) safely defer to AIs?" by Ryan Greenblatt',
        'Redwood Research Blog'
      )
      // Tasklet: author = Redwood Research, clean title
      const tasklet = normalizeTitle(
        'How do we (more) safely defer to AIs?',
        'Redwood Research'
      )
      expect(spotify).toBe(tasklet)
    })

    it('matches same-author items with and without quoted attribution', () => {
      // Both Redwood Research, but one has Spotify formatting
      const withAttr = normalizeTitle(
        '"Sonnet 4.5\'s eval gaming seriously undermines alignment evals" by Alexa Pan, Ryan Greenblatt',
        'Redwood Research'
      )
      const plain = normalizeTitle(
        'Sonnet 4.5\'s eval gaming seriously undermines alignment evals',
        'Redwood Research'
      )
      expect(withAttr).toBe(plain)
    })
  })
})

// ---------------------------------------------------------------------------
// levenshteinDistance
// ---------------------------------------------------------------------------

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0)
  })

  it('returns length for empty vs non-empty', () => {
    expect(levenshteinDistance('', 'hello')).toBe(5)
    expect(levenshteinDistance('hello', '')).toBe(5)
  })

  it('returns 0 for both empty', () => {
    expect(levenshteinDistance('', '')).toBe(0)
  })

  it('computes single character difference', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1)
    expect(levenshteinDistance('cat', 'cats')).toBe(1)
    expect(levenshteinDistance('cat', 'at')).toBe(1)
  })

  it('computes multi-character difference', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3)
  })

  it('handles completely different strings', () => {
    expect(levenshteinDistance('abc', 'xyz')).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// titlesAreFuzzyMatch
// ---------------------------------------------------------------------------

describe('titlesAreFuzzyMatch', () => {
  it('matches identical strings', () => {
    expect(titlesAreFuzzyMatch('the great article about things', 'the great article about things')).toBe(true)
  })

  it('matches with small typo in long title', () => {
    // 1 char diff in a 30+ char string
    expect(titlesAreFuzzyMatch('the great article about things', 'the great artcle about things')).toBe(true)
  })

  it('matches with 2 char diff in long title', () => {
    expect(titlesAreFuzzyMatch('understanding machine learning today', 'understanding machne learnng today')).toBe(true)
  })

  it('rejects short titles even if similar', () => {
    // "cat" vs "bat" — too short for fuzzy matching
    expect(titlesAreFuzzyMatch('cat food', 'bat food')).toBe(false)
  })

  it('rejects titles with > 3 differences', () => {
    expect(titlesAreFuzzyMatch('the quick brown fox jumps', 'a slow green cat leaps')).toBe(false)
  })

  it('rejects when relative distance >= 10%', () => {
    // 3 char diff in 10 char string = 30% — should reject
    expect(titlesAreFuzzyMatch('abcdefghij', 'xyzdefghij')).toBe(false)
  })

  it('accepts small diff in long multi-word title', () => {
    const a = 'understanding the alignment problm deeply'
    const b = 'understanding the alignment problem deeply'
    // 1 diff, same boundary tokens — should match
    expect(titlesAreFuzzyMatch(a, b)).toBe(true)
  })

  it('rejects numbered series entries (digit-only difference)', () => {
    // "open thread 418" vs "open thread 419" — different episodes
    expect(titlesAreFuzzyMatch('open thread 418', 'open thread 419')).toBe(false)
  })

  it('rejects hidden open thread numbered variants', () => {
    expect(titlesAreFuzzyMatch('hidden open thread 419.5', 'hidden open thread 420.5')).toBe(false)
  })

  it('still matches non-digit typos in titles with numbers', () => {
    // Typo in a middle word, not in boundary tokens or the number
    expect(titlesAreFuzzyMatch('exploring thread 419 in great depth', 'exploring thred 419 in great depth')).toBe(true)
  })

  it('rejects when first boundary tokens differ', () => {
    expect(titlesAreFuzzyMatch('the alignment newsletter edition', 'an alignment newsletter edition')).toBe(false)
  })

  it('rejects when last boundary tokens differ', () => {
    expect(titlesAreFuzzyMatch('the alignment newsletter here', 'the alignment newsletter now')).toBe(false)
  })

  it('rejects single-token strings even if similar', () => {
    // No word boundaries to compare — boundary check fails
    expect(titlesAreFuzzyMatch('abcdefghijklmnop', 'abcdefghijklmnos')).toBe(false)
  })

  it('rejects when first word has a typo', () => {
    // Boundary token mismatch on first word
    expect(titlesAreFuzzyMatch('understnding thread 419 deeply', 'understanding thread 419 deeply')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// fuzzyTitleScore
// ---------------------------------------------------------------------------

describe('fuzzyTitleScore', () => {
  it('returns 1 for identical strings', () => {
    expect(fuzzyTitleScore('the great article about things', 'the great article about things')).toBe(1)
  })

  it('returns null for short strings', () => {
    expect(fuzzyTitleScore('cat food', 'bat food')).toBeNull()
  })

  it('returns similarity score for valid fuzzy match', () => {
    const score = fuzzyTitleScore(
      'understanding the alignment problem deeply',
      'understanding the alignment problm deeply'
    )
    expect(score).not.toBeNull()
    expect(score!).toBeGreaterThan(0.95)
    expect(score!).toBeLessThan(1)
  })

  it('returns null when boundary tokens differ', () => {
    expect(fuzzyTitleScore(
      'the alignment newsletter edition',
      'an alignment newsletter edition'
    )).toBeNull()
  })

  it('returns null for digit-only differences', () => {
    expect(fuzzyTitleScore('open thread 418', 'open thread 419')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// baseTitle — strips subtitle / series suffix for book dedup (#42)
// ---------------------------------------------------------------------------

describe('baseTitle', () => {
  it('strips a trailing ": subtitle"', () => {
    expect(baseTitle('manufacturing consent: the political economy of the mass media'))
      .toBe('manufacturing consent')
  })

  it('strips a trailing " (series, #n)" suffix', () => {
    expect(baseTitle('children of time (children of time, #1)'))
      .toBe('children of time')
  })

  it('strips both a parenthetical and a subtitle', () => {
    expect(baseTitle('the title: a subtitle (the series, #2)')).toBe('the title')
  })

  it('strips a parenthetical that follows a subtitle', () => {
    expect(baseTitle("the hitchhiker's guide to the galaxy (the hitchhiker's guide to the galaxy, #1)"))
      .toBe("the hitchhiker's guide to the galaxy")
  })

  it('leaves a plain title unchanged', () => {
    expect(baseTitle('manufacturing consent')).toBe('manufacturing consent')
  })

  it('returns empty string for empty input', () => {
    expect(baseTitle('')).toBe('')
  })

  it('does not strip a leading colon (no real subtitle)', () => {
    expect(baseTitle(': weird')).toBe(': weird')
  })

  it('trims surrounding whitespace after stripping', () => {
    expect(baseTitle('on the edge : the art of risking everything')).toBe('on the edge')
  })
})

describe('normalizeTitle ReDoS bounds (#281 F3)', () => {
  it('strips a trailing author in linear time on whitespace-heavy titles', () => {
    const title = `a${' \t'.repeat(60_000)}a`
    const start = performance.now()
    normalizeTitle(title, 'Zvi Mowshowitz')
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('still strips " by Author" and dash-author suffixes', () => {
    expect(normalizeTitle('Great Post by Zvi Mowshowitz', 'Zvi Mowshowitz')).toBe(normalizeTitle('Great Post'))
    expect(normalizeTitle('Great Post — Zvi Mowshowitz', 'Zvi Mowshowitz')).toBe(normalizeTitle('Great Post'))
    expect(normalizeTitle('Great Post-Zvi Mowshowitz', 'zvi mowshowitz')).toBe(normalizeTitle('Great Post'))
    // "by" must be its own word
    expect(normalizeTitle('Standby Zvi Mowshowitz', 'Zvi Mowshowitz')).toBe(
      normalizeTitle('Standby Zvi Mowshowitz')
    )
  })
})
