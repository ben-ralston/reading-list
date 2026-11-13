// Shared copy-URL-then-open-web-app handoff for reader services that expose no
// deep link or share target (ElevenReader desktop path, Askwho Casts everywhere).

import { openExternal } from '@/lib/links'

export type CopyOpenResult = 'copied' | 'opened'

export async function copyAndOpen(copyText: string, openUrl: string): Promise<CopyOpenResult> {
  let copied = false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyText)
      copied = true
    }
  } catch {
    // Clipboard blocked or failed — open the app anyway, but don't claim "copied".
  }
  // Route through openExternal so the iOS standalone PWA escapes to Safari
  // instead of the layered in-app browser sheet (#235).
  openExternal(openUrl)
  return copied ? 'copied' : 'opened'
}
