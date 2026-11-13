import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getIronSession } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/auth'

export async function middleware(request: NextRequest) {
  const response = NextResponse.next()

  // Get session from cookies
  const session = await getIronSession<SessionData>(request, response, sessionOptions)

  // If not authenticated, reject. API routes get 401 JSON — a 307 redirect to
  // the /sign-in HTML page silently corrupts API clients: fetchWithRetry follows
  // it, mutation helpers read the 200 HTML as a successful write (silent write
  // loss on an expired session), and GET consumers throw "Unexpected token <"
  // parsing HTML as JSON (RLV-015). Page routes still redirect for humans.
  if (!session.isAuthenticated) {
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const signInUrl = new URL('/sign-in', request.url)
    return NextResponse.redirect(signInUrl)
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - /sign-in (login page)
     * - /api/cron/* (Vercel cron jobs - have their own protection)
     * - /api/sync/* (webhooks - have their own secret validation)
     * - /api/add-entry (iOS Share Sheet, #191 - dual cookie/bearer auth in-route)
     * - /_next/static (static files)
     * - /_next/image (image optimization files)
     * - /favicon.ico, /manifest.json, /icon-*.* (static assets)
     */
    '/((?!sign-in|api/cron|api/sync|api/add-entry|_next/static|_next/image|favicon\\.ico|manifest\\.json|icon-.*\\..*).*)',
  ],
}
