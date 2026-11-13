// Polling endpoint for Askwho Casts conversion status (#317). Cookie-auth via
// the default middleware matcher. The home page polls it every ~4 s only
// while some item has an active conversion.
import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { listForPolling, getHeartbeatAgeSeconds } from '@/lib/awc/conversions-repo'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const now = Date.now()
    const [conversions, heartbeatAgeSeconds] = await Promise.all([
      listForPolling(supabase, now),
      getHeartbeatAgeSeconds(supabase, now),
    ])
    return NextResponse.json({ conversions, heartbeatAgeSeconds }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[AWC Conversions API] Error:', error)
    return NextResponse.json({ error: 'Failed to load conversions' }, { status: 500 })
  }
}
