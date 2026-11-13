import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockUsePathname = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}))

import { SettingsNav } from './settings-nav'

describe('SettingsNav', () => {
  beforeEach(() => {
    mockUsePathname.mockReset()
  })

  it('links to the feeds and status sub-pages', () => {
    mockUsePathname.mockReturnValue('/settings/feeds')
    render(<SettingsNav />)

    expect(screen.getByRole('link', { name: 'Feeds' }).getAttribute('href')).toBe('/settings/feeds')
    expect(screen.getByRole('link', { name: 'Status' }).getAttribute('href')).toBe('/settings/status')
  })

  it('links to the Share (iOS Shortcut) sub-page (#191)', () => {
    mockUsePathname.mockReturnValue('/settings/feeds')
    render(<SettingsNav />)

    expect(screen.getByRole('link', { name: 'Share' }).getAttribute('href')).toBe('/settings/share')
  })

  it('marks Share active when on the share path (#191)', () => {
    mockUsePathname.mockReturnValue('/settings/share')
    render(<SettingsNav />)

    expect(screen.getByRole('link', { name: 'Share' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Feeds' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks the link matching the current path with aria-current="page"', () => {
    mockUsePathname.mockReturnValue('/settings/status')
    render(<SettingsNav />)

    expect(screen.getByRole('link', { name: 'Status' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Feeds' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks Feeds active when on the feeds path', () => {
    mockUsePathname.mockReturnValue('/settings/feeds')
    render(<SettingsNav />)

    expect(screen.getByRole('link', { name: 'Feeds' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Status' }).getAttribute('aria-current')).toBeNull()
  })
})
