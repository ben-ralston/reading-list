import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SearchField } from './search-field'

describe('SearchField (#283)', () => {
  it('renders a labelled search input with the given placeholder and value', () => {
    const { getByRole } = render(
      <SearchField value="bitter" onChange={vi.fn()} placeholder="Search queue" />,
    )
    const input = getByRole('searchbox', { name: 'Search by title or author' }) as HTMLInputElement
    expect(input.value).toBe('bitter')
    expect(input.placeholder).toBe('Search queue')
  })

  it('reports typed text through onChange', () => {
    const onChange = vi.fn()
    const { getByRole } = render(<SearchField value="" onChange={onChange} placeholder="Search" />)
    fireEvent.change(getByRole('searchbox'), { target: { value: 'less' } })
    expect(onChange).toHaveBeenCalledWith('less')
  })

  it('hides the clear button when empty and clears via it when not', () => {
    const onChange = vi.fn()
    const empty = render(<SearchField value="" onChange={onChange} placeholder="Search" />)
    expect(empty.queryByRole('button', { name: 'Clear search' })).toBeNull()
    empty.unmount()

    const filled = render(<SearchField value="x" onChange={onChange} placeholder="Search" />)
    fireEvent.click(filled.getByRole('button', { name: 'Clear search' }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('clears on Escape', () => {
    const onChange = vi.fn()
    const { getByRole } = render(<SearchField value="x" onChange={onChange} placeholder="Search" />)
    fireEvent.keyDown(getByRole('searchbox'), { key: 'Escape' })
    expect(onChange).toHaveBeenCalledWith('')
  })
})
