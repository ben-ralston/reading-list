import { afterAll, describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { LocalTime } from './local-time'

// Pin the runtime zone so the hydrated render is deterministic — CI runs in
// UTC, where an unpinned "not UTC" assertion would be meaningless. Restored
// afterwards: vitest reuses worker forks across files.
const originalTz = process.env.TZ
process.env.TZ = 'America/New_York'
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

const ISO = '2026-08-17T18:34:00Z'

describe('LocalTime (#282)', () => {
  it('renders an em dash for null', () => {
    render(<LocalTime iso={null} />)
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('server-renders the time explicitly labelled UTC (never an unlabelled server-zone time)', () => {
    const html = renderToString(<LocalTime iso={ISO} />)
    expect(html).toContain('6:34 PM UTC')
  })

  it('after hydration renders the viewer-local clock time with a zone abbreviation and a full-date tooltip', () => {
    render(<LocalTime iso={ISO} />)
    const el = screen.getByText((_, node) => node?.tagName === 'TIME')
    expect(el.getAttribute('datetime')).toBe(ISO)
    expect(el.textContent).toBe('2:34 PM EDT')
    expect(el.getAttribute('title')).toBe('Aug 17, 2026, 2:34 PM EDT')
  })

  it('hydrates the server-rendered UTC markup without a mismatch, then shows local time', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    container.innerHTML = renderToString(<LocalTime iso={ISO} />)
    const onRecoverableError = vi.fn()
    await act(async () => {
      hydrateRoot(container, <LocalTime iso={ISO} />, { onRecoverableError })
    })
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.querySelector('time')?.textContent).toBe('2:34 PM EDT')
    container.remove()
  })
})
