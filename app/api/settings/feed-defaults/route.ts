import { NextResponse } from 'next/server'
import {
  getDefaultBackfillDays,
  setDefaultBackfillDays,
  ALLOWED_BACKFILL_PRESETS,
} from '@/lib/app-settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const defaultBackfillDays = await getDefaultBackfillDays()
    return NextResponse.json({ defaultBackfillDays })
  } catch (e) {
    console.error('[Feed Defaults] GET failed:', e)
    return NextResponse.json({ error: 'Failed to load setting' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  let body: { defaultBackfillDays?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const v = body.defaultBackfillDays
  const isPreset =
    typeof v === 'number' && (ALLOWED_BACKFILL_PRESETS as readonly number[]).includes(v)
  if (v !== null && !isPreset) {
    return NextResponse.json(
      { error: `defaultBackfillDays must be null or one of ${ALLOWED_BACKFILL_PRESETS.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    await setDefaultBackfillDays(v as number | null)
    return NextResponse.json({ defaultBackfillDays: v as number | null })
  } catch (e) {
    console.error('[Feed Defaults] PUT failed:', e)
    return NextResponse.json({ error: 'Failed to save setting' }, { status: 500 })
  }
}
