import { NextResponse } from 'next/server'
import { updateFeed, type FeedPatch } from '@/lib/rss/feeds-repo'

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch: FeedPatch = {}
  if (typeof body.active === 'boolean') patch.active = body.active
  if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim()
  if (typeof body.authorName === 'string') patch.authorName = body.authorName.trim() || null
  if (typeof body.platform === 'string' && body.platform.trim()) patch.platform = body.platform.trim()

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  try {
    const updated = await updateFeed(id, patch)
    if (!updated) {
      return NextResponse.json({ error: 'Feed not found' }, { status: 404 })
    }
    return NextResponse.json(updated)
  } catch (e) {
    console.error('[Feeds API] PATCH failed:', e)
    return NextResponse.json({ error: 'Failed to update feed' }, { status: 500 })
  }
}
