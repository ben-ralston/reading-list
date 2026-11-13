import { NextResponse } from 'next/server'
import { setEverythingLastSeen } from '@/lib/app-settings'

export const dynamic = 'force-dynamic'

// POST { seenAt } — record a visit to /everything (#377), so items added after
// it are marked NEW on the next visit, on any device.
export async function POST(request: Request) {
  let body: { seenAt?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const seenAt = body.seenAt
  if (typeof seenAt !== 'string' || Number.isNaN(Date.parse(seenAt))) {
    return NextResponse.json({ error: 'seenAt must be an ISO time' }, { status: 400 })
  }
  try {
    await setEverythingLastSeen(seenAt, Date.now())
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[Everything Seen] POST failed:', e)
    return NextResponse.json({ error: 'Failed to save setting' }, { status: 500 })
  }
}
