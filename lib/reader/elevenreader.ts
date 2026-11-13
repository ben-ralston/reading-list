// Client-side handoff to ElevenLabs Reader ("ElevenReader") for listening to a
// text article via text-to-speech (#171).
//
// The spike found no custom URL scheme and no `?url=` web handoff, so there is
// no clean deep link. The only true auto-load path is the mobile share sheet:
// the iOS/Android ElevenReader app registers a share target, so handing it a URL
// via the Web Share API drops the user straight into the app with the article
// loaded. On desktop (no Web Share API) we copy the URL and open the web app so
// the user only has to paste.

import { type QueueItem } from '@/lib/queue-client'
import { hasMediaType } from '@/lib/media-type'
import { getPrimaryLink } from '@/lib/transform-utils'
import { isIos } from '@/lib/links'
import { copyAndOpen } from './handoff'

export const ELEVENREADER_URL = 'https://elevenreader.io/'

// Name of the user's iOS Shortcut (one action: "Open App → ElevenReader").
// "Listen again" runs it to launch the app directly, since ElevenReader exposes
// no reliable per-article deep link and re-sharing makes it re-compile the post.
export const ELEVENREADER_SHORTCUT_NAME = 'Open ElevenReader'

/**
 * On iOS, the `shortcuts://` URL that runs the user's "Open ElevenReader"
 * Shortcut (which launches the app). Returns null off iOS so callers fall back
 * to the share/copy handoff.
 */
export function iosShortcutLaunchUrl(): string | null {
  if (!isIos()) return null
  return `shortcuts://run-shortcut?name=${encodeURIComponent(ELEVENREADER_SHORTCUT_NAME)}`
}

// A feed item is eligible for ElevenReader TTS when it isn't a book, has no
// native-audio source (TTS would be redundant), and has a real http(s) link.
export function canListenInReader(item: QueueItem, isBooks: boolean): boolean {
  if (isBooks) return false
  if (hasMediaType(item, 'audio')) return false
  return getPrimaryLink(item.sources).startsWith('http')
}

/**
 * Outcome of a handoff attempt.
 * - 'shared'    — handed to the native share sheet (mobile).
 * - 'copied'    — URL copied to clipboard + web app opened (desktop).
 * - 'opened'    — web app opened but the clipboard was unavailable/blocked, so
 *                 nothing was copied (degraded desktop path).
 * - 'cancelled' — the user dismissed the share sheet.
 */
export type SendToReaderResult = 'shared' | 'copied' | 'opened' | 'cancelled'

function canWebShare(url: string): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return false
  }
  // canShare is optional; when present it vets the payload. Absent => assume ok.
  return typeof navigator.canShare !== 'function' || navigator.canShare({ url })
}

/**
 * Hand `url` to ElevenReader. Prefers the native share sheet (mobile), falling
 * back to clipboard-copy + opening the web app (desktop). The share payload is
 * the URL alone (no title/text) so ElevenReader treats it as a link to scrape
 * rather than free text.
 */
export async function sendToElevenReader(url: string): Promise<SendToReaderResult> {
  if (canWebShare(url)) {
    try {
      await navigator.share({ url })
      return 'shared'
    } catch (error) {
      // User dismissed the sheet — do nothing (don't mark as sent).
      if (error instanceof Error && error.name === 'AbortError') {
        return 'cancelled'
      }
      // Any other share failure: fall back to the copy + open path.
    }
  }
  return copyAndOpen(url, ELEVENREADER_URL)
}
