import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SummarySection } from './summary-section'

describe('SummarySection', () => {
  it('displays summary text when summary exists', () => {
    render(
      <SummarySection
        contentItemId={1}
        summary="A great book about programming."
        summaryGeneratedAt="2026-03-14T00:00:00Z"
        itemTitle="Test Book"
        itemLink="https://example.com"

      />
    )

    expect(screen.getByText('A great book about programming.')).toBeDefined()
    expect(screen.getByText('AI Summary')).toBeDefined()
  })

  it('shows Generate Summary button when no summary', () => {
    render(
      <SummarySection
        contentItemId={1}
        summary={null}
        summaryGeneratedAt={null}
        itemTitle="Test Book"
        itemLink="https://example.com"

      />
    )

    expect(screen.getByText('Generate Summary')).toBeDefined()
  })

  it('renders bold markdown as strong elements', () => {
    const { container } = render(
      <SummarySection
        contentItemId={1}
        summary="A book about **resilience** and **growth**."
        summaryGeneratedAt="2026-03-14T00:00:00Z"
        itemTitle="Test Book"
        itemLink="https://example.com"
      />
    )

    const strongElements = container.querySelectorAll('strong')
    expect(strongElements.length).toBe(2)
    expect(strongElements[0].textContent).toBe('resilience')
    expect(strongElements[1].textContent).toBe('growth')
  })

  it('shows Regenerate link when summary exists', () => {
    render(
      <SummarySection
        contentItemId={1}
        summary="A great book."
        summaryGeneratedAt="2026-03-14T00:00:00Z"
        itemTitle="Test Book"
        itemLink="https://example.com"

      />
    )

    expect(screen.getByText(/Regenerate/)).toBeDefined()
  })
})

const data = {
  oneLiner: 'Core claim.',
  bullets: ['First point.', 'Second point.', 'Third point.', 'Fourth point.'],
  sourceAccess: 'full_text' as const,
  model: 'claude-opus-5-5',
}

describe('SummarySection with structured summaryData (#304)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders bullets under a "More" header and a full-text chip', () => {
    render(
      <SummarySection contentItemId={1} summary="Core claim." summaryData={data}
        summaryGeneratedAt="2026-09-27T00:00:00Z" itemTitle="T" itemLink="https://example.com" />
    )
    expect(screen.getByText('More')).toBeDefined()
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(data.bullets)
    expect(screen.getByText('Read full text')).toBeDefined()
    // The one-liner lives on the card, not repeated in the panel.
    expect(screen.queryByText('Core claim.')).toBeNull()
  })

  it('shows the descriptions-only chip', () => {
    render(
      <SummarySection contentItemId={1} summary="Core claim." summaryData={{ ...data, sourceAccess: 'descriptions_only' }}
        summaryGeneratedAt="2026-09-27T00:00:00Z" itemTitle="T" itemLink={null} />
    )
    expect(screen.getByText('Descriptions only')).toBeDefined()
  })

  it('shows the no-access one-liner when there are no bullets', () => {
    const noAccess = { ...data, oneLiner: "Couldn't access the content: a 2019 episode", bullets: [], sourceAccess: 'descriptions_only' as const }
    render(
      <SummarySection contentItemId={1} summary={noAccess.oneLiner} summaryData={noAccess}
        summaryGeneratedAt="2026-09-27T00:00:00Z" itemTitle="T" itemLink={null} />
    )
    expect(screen.getByText(noAccess.oneLiner)).toBeDefined()
  })

  it('passes summaryData to onSummaryGenerated after Generate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ summary: 'Core claim.', summaryData: data, generatedAt: '2026-09-27T00:00:00Z' }),
    }))
    const onGenerated = vi.fn()
    render(
      <SummarySection contentItemId={1} summary={null} summaryData={null} summaryGeneratedAt={null}
        itemTitle="T" itemLink={null} onSummaryGenerated={onGenerated} />
    )
    fireEvent.click(screen.getByText('Generate Summary'))
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith('Core claim.', '2026-09-27T00:00:00Z', data))
    expect(screen.getByText('First point.')).toBeDefined()
  })
})
