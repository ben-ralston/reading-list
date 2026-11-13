import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilterSheet, FilterSummaryChips } from './filter-sheet'
import type { MediaFilter } from '@/lib/media-type'
import type { ReadState } from '@/lib/read-state'

const baseProps = () => ({
  mediaFilter: 'all' as MediaFilter,
  onMediaFilterChange: vi.fn(),
  mediaCounts: { all: 4, audio: 2, text: 3 },
  authorOptions: [
    { key: 'jane doe', label: 'Jane Doe', count: 2 },
    {
      key: 'the knowledge project with shane parrish',
      label: 'The Knowledge Project with Shane Parrish',
      count: 1,
    },
  ],
  selectedAuthors: [] as string[],
  onSelectedAuthorsChange: vi.fn(),
  readStateOptions: [
    { key: 'in-progress' as const, label: 'In progress', count: 1 },
    { key: 'confirmed' as const, label: 'Confirmed', count: 2 },
    { key: 'suggested' as const, label: 'Suggested', count: 0 },
  ],
  selectedReadStates: [] as ReadState[],
  onSelectedReadStatesChange: vi.fn(),
})

describe('FilterSheet trigger + shell (#241)', () => {
  it('renders the Filters trigger with no badge when nothing is active', () => {
    render(<FilterSheet {...baseProps()} />)
    const trigger = screen.getByRole('button', { name: /^Filters/ })
    expect(trigger.getAttribute('data-filters-active')).toBe('false')
    expect(trigger.textContent).toBe('')
  })

  it('shows the total active count on the trigger (media counts as one)', () => {
    render(
      <FilterSheet
        {...baseProps()}
        mediaFilter="audio"
        selectedReadStates={['in-progress']}
        selectedAuthors={['Jane Doe']}
      />,
    )
    // The accessible name announces the count too (review: badge is aria-hidden
    // by the explicit label, so the label must carry the state).
    const trigger = screen.getByRole('button', { name: 'Filters, 3 active' })
    expect(trigger.getAttribute('data-filters-active')).toBe('true')
    expect(trigger.textContent).toBe('3')
  })

  it('keeps the sheet body scrollable within the viewport', () => {
    render(<FilterSheet {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    const dialog = screen.getByRole('dialog', { name: 'Filters' })
    // Short-viewport guard (review): the sheet is height-bounded and the
    // section body scrolls, so Media/Status can never overflow off-screen.
    expect(dialog.className).toContain('max-h-')
    const body = dialog.querySelector('[data-sheet-body]') as HTMLElement
    expect(body.className).toContain('overflow-y-auto')
  })

  it('opens the sheet on trigger click and closes it via Done', () => {
    render(<FilterSheet {...baseProps()} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('FilterSheet media section (#241)', () => {
  function openSheet(props = {}) {
    render(<FilterSheet {...baseProps()} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  }

  it('renders the three media options with counts and marks the active one', () => {
    openSheet({ mediaFilter: 'audio' as MediaFilter })
    expect(screen.getByRole('button', { name: 'All (4)' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Audio (2)' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Text (3)' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('routes media clicks through the callback and keeps the sheet open', () => {
    const onMediaFilterChange = vi.fn()
    openSheet({ onMediaFilterChange })
    fireEvent.click(screen.getByRole('button', { name: 'Text (3)' }))
    expect(onMediaFilterChange).toHaveBeenCalledWith('text')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('FilterSheet status section (#241)', () => {
  function openSheet(props = {}) {
    render(<FilterSheet {...baseProps()} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  }

  it('renders a chip per read-state with counts, zero-count included', () => {
    openSheet()
    expect(screen.getByRole('button', { name: 'In progress (1)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirmed (2)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Suggested (0)' })).toBeTruthy()
  })

  it('toggles a state on', () => {
    const onSelectedReadStatesChange = vi.fn()
    openSheet({ onSelectedReadStatesChange })
    fireEvent.click(screen.getByRole('button', { name: 'In progress (1)' }))
    expect(onSelectedReadStatesChange).toHaveBeenCalledWith(['in-progress'])
  })

  it('toggles a selected state off', () => {
    const onSelectedReadStatesChange = vi.fn()
    openSheet({
      selectedReadStates: ['in-progress', 'confirmed'] as ReadState[],
      onSelectedReadStatesChange,
    })
    const chip = screen.getByRole('button', { name: 'Confirmed (2)' })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip)
    expect(onSelectedReadStatesChange).toHaveBeenCalledWith(['in-progress'])
  })

  it('renders whatever option set it is given (book labels)', () => {
    openSheet({
      readStateOptions: [
        { key: 'in-progress' as const, label: 'In progress', count: 1 },
        { key: 'not-started' as const, label: 'Not started', count: 3 },
      ],
    })
    expect(screen.getByRole('button', { name: 'Not started (3)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Confirmed/ })).toBeNull()
  })
})

describe('FilterSheet authors section (#241)', () => {
  function openSheet(props = {}) {
    render(<FilterSheet {...baseProps()} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  }

  it('renders a checkbox row per author', () => {
    openSheet()
    expect(screen.getByRole('checkbox', { name: 'Jane Doe' })).toBeTruthy()
    expect(
      screen.getByRole('checkbox', { name: 'The Knowledge Project with Shane Parrish' }),
    ).toBeTruthy()
  })

  it('checks selected authors and toggles selection through the callback', () => {
    const onSelectedAuthorsChange = vi.fn()
    openSheet({ selectedAuthors: ['Jane Doe'], onSelectedAuthorsChange })

    const jane = screen.getByRole('checkbox', { name: 'Jane Doe' }) as HTMLInputElement
    expect(jane.checked).toBe(true)
    fireEvent.click(jane)
    expect(onSelectedAuthorsChange).toHaveBeenCalledWith([])

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'The Knowledge Project with Shane Parrish' }),
    )
    expect(onSelectedAuthorsChange).toHaveBeenCalledWith([
      'Jane Doe',
      'The Knowledge Project with Shane Parrish',
    ])
  })

  it('pads the scroll container so counts clear the overlay scrollbar', () => {
    openSheet()
    const scroller = screen.getByTitle('Jane Doe').closest('label')!.parentElement!
    expect(scroller.className).toContain('overflow-y-auto')
    expect(scroller.className).toMatch(/\bpr-\d/)
  })

  it('truncates long names with the full name on title', () => {
    openSheet()
    const name = screen.getByTitle('The Knowledge Project with Shane Parrish')
    expect(name.className).toContain('truncate')
  })
})

describe('FilterSheet clear all (#241)', () => {
  it('is disabled when nothing is active', () => {
    render(<FilterSheet {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    expect(
      (screen.getByRole('button', { name: 'Clear all' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('resets all three filter groups', () => {
    const onMediaFilterChange = vi.fn()
    const onSelectedAuthorsChange = vi.fn()
    const onSelectedReadStatesChange = vi.fn()
    render(
      <FilterSheet
        {...baseProps()}
        mediaFilter="text"
        selectedAuthors={['Jane Doe']}
        selectedReadStates={['confirmed'] as ReadState[]}
        onMediaFilterChange={onMediaFilterChange}
        onSelectedAuthorsChange={onSelectedAuthorsChange}
        onSelectedReadStatesChange={onSelectedReadStatesChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onMediaFilterChange).toHaveBeenCalledWith('all')
    expect(onSelectedAuthorsChange).toHaveBeenCalledWith([])
    expect(onSelectedReadStatesChange).toHaveBeenCalledWith([])
  })
})

describe('FilterSummaryChips (#241)', () => {
  it('renders nothing when no filters are active', () => {
    const { container } = render(<FilterSummaryChips {...baseProps()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a dismissible chip per active filter', () => {
    const onMediaFilterChange = vi.fn()
    const onSelectedReadStatesChange = vi.fn()
    const onSelectedAuthorsChange = vi.fn()
    render(
      <FilterSummaryChips
        {...baseProps()}
        mediaFilter="audio"
        selectedReadStates={['in-progress'] as ReadState[]}
        selectedAuthors={['Jane Doe']}
        onMediaFilterChange={onMediaFilterChange}
        onSelectedReadStatesChange={onSelectedReadStatesChange}
        onSelectedAuthorsChange={onSelectedAuthorsChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Audio' }))
    expect(onMediaFilterChange).toHaveBeenCalledWith('all')

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter In progress' }))
    expect(onSelectedReadStatesChange).toHaveBeenCalledWith([])

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Jane Doe' }))
    expect(onSelectedAuthorsChange).toHaveBeenCalledWith([])
  })

  it('clears everything via the Clear all chip', () => {
    const onMediaFilterChange = vi.fn()
    const onSelectedAuthorsChange = vi.fn()
    const onSelectedReadStatesChange = vi.fn()
    render(
      <FilterSummaryChips
        {...baseProps()}
        mediaFilter="text"
        onMediaFilterChange={onMediaFilterChange}
        onSelectedAuthorsChange={onSelectedAuthorsChange}
        onSelectedReadStatesChange={onSelectedReadStatesChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }))
    expect(onMediaFilterChange).toHaveBeenCalledWith('all')
    expect(onSelectedAuthorsChange).toHaveBeenCalledWith([])
    expect(onSelectedReadStatesChange).toHaveBeenCalledWith([])
  })
})
