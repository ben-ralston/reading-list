// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { allowedHostsFor, navigationViolation } from './nav-guard'

const NAV = 'mcp__claude-in-chrome__navigate'
const allowed = allowedHostsFor('https://www.astralcodexten.com/p/some-post')

describe('navigationViolation', () => {
  it('allows Askwho Casts and the item host (www or bare)', () => {
    for (const url of [
      'https://app.askwhocasts.com/#script',
      'https://astralcodexten.com/p/some-post',
      'https://www.astralcodexten.com/p/some-post',
      'app.askwhocasts.com',
    ]) {
      expect(navigationViolation(NAV, { url }, allowed)).toBeNull()
    }
  })

  it('flags any other host, including lookalikes', () => {
    expect(navigationViolation(NAV, { url: 'https://mail.google.com/' }, allowed)).toBe('mail.google.com')
    expect(navigationViolation(NAV, { url: 'https://attacker.example/?d=x' }, allowed)).toBe('attacker.example')
    expect(navigationViolation(NAV, { url: 'https://app.askwhocasts.com.evil.io/' }, allowed)).toBe('app.askwhocasts.com.evil.io')
    expect(navigationViolation(NAV, { url: 'evil.io' }, allowed)).toBe('evil.io')
  })

  it('fails closed on inputs another URL parser could read differently', () => {
    expect(navigationViolation(NAV, { url: 'https://app.askwhocasts.com\\@evil.io/' }, allowed)).not.toBeNull()
    expect(navigationViolation(NAV, { url: ' https://app.askwhocasts.com/' }, allowed)).not.toBeNull()
    expect(navigationViolation(NAV, { url: 'https://app.askwhocasts.com/\n' }, allowed)).not.toBeNull()
    expect(navigationViolation(NAV, { url: 'back' }, allowed)).toBe('history navigation')
    expect(navigationViolation(NAV, { url: 'forward' }, allowed)).toBe('history navigation')
    expect(navigationViolation(NAV, {}, allowed)).toBe('missing url')
  })

  it('flags non-http schemes', () => {
    expect(navigationViolation(NAV, { url: 'javascript:alert(1)' }, allowed)).toBe('javascript:')
    expect(navigationViolation(NAV, { url: 'file:///etc/passwd' }, allowed)).toBe('file:')
  })

  it('ignores tools that are not navigate', () => {
    expect(navigationViolation('mcp__claude-in-chrome__computer', { url: 'https://evil.io' }, allowed)).toBeNull()
  })

  it('only allows Askwho Casts when the item URL is unparseable', () => {
    const onlyAwc = allowedHostsFor('not a url')
    expect(navigationViolation(NAV, { url: 'https://app.askwhocasts.com/' }, onlyAwc)).toBeNull()
    expect(navigationViolation(NAV, { url: 'https://example.com/' }, onlyAwc)).toBe('example.com')
  })
})
