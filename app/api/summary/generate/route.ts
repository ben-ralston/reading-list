import { NextResponse } from 'next/server'
import { generateSummary } from '@/lib/summary'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { contentItemId, skipExisting } = body

    if (!contentItemId || typeof contentItemId !== 'number' || !Number.isInteger(contentItemId) || contentItemId < 1) {
      return NextResponse.json(
        { error: 'contentItemId (number) is required' },
        { status: 400 }
      )
    }

    const result = await generateSummary(contentItemId, { skipExisting })

    return NextResponse.json(result)
  } catch (error) {
    console.error('[Summary API] Error generating summary:', error)

    if (error instanceof Error && error.message.includes('not found')) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }

    return NextResponse.json(
      { error: 'Failed to generate summary' },
      { status: 500 }
    )
  }
}
