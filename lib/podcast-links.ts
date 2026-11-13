// Open-target selection for queue source anchors (#236).
//
// Askwho Casts sources store the raw enclosure MP3 as their link, but on iOS
// the episode lives in the user's Apple Podcasts subscription of the private
// feed, so the anchor should land there instead of playing the MP3 in the
// browser. Phase 0 on-device testing (see the #236 spec) ruled out show-level
// podcast:// deep links — they re-prompt "Follow a Show by URL" and create a
// duplicate subscription if accepted. The Library universal link is the best
// working target; the show sits one tap away.
import { externalHref, isIos } from './links'
import { ASKWHOCASTS_PLATFORM, isAwcCommentsSource } from './media-type'

export const APPLE_PODCASTS_LIBRARY_URL = 'https://podcasts.apple.com/library'

export interface SourceOpenTarget {
  href: string
  label: string
  // Secondary line naming the specific source within the platform — the Spotify
  // show name (#245). Non-null only when the caller asks to disambiguate and the
  // source actually carries a label; legacy rows stay null and render as before.
  sublabel: string | null
  applePodcasts: boolean
}

// Universal links only hand off to the app when left plain (#197) —
// externalHref owns that invariant via the UNIVERSAL_LINK_HOSTS registry and
// the custom-domain Substack bridge in lib/links.ts (#267), so every branch
// routes through it and other platforms keep the hydration-gated x-safari
// treatment.
export function sourceOpenTarget(
  source: { platform: string; link?: string | null; sourceLabel?: string | null },
  hydrated: boolean,
  disambiguate = false,
): SourceOpenTarget {
  if (hydrated && isIos() && source.platform === ASKWHOCASTS_PLATFORM) {
    // No sublabel here: this label is an action ("Open in Apple Podcasts"), not
    // a platform name, and AWC is already distinct from every other platform.
    // A comments episode is the exception (#368): it isn't the article's audio.
    return {
      href: externalHref(APPLE_PODCASTS_LIBRARY_URL),
      label: 'Open in Apple Podcasts',
      sublabel: isAwcCommentsSource(source) ? source.sourceLabel! : null,
      applePodcasts: true,
    }
  }
  const link = source.link ?? ''
  const trimmedLabel = source.sourceLabel?.trim() ?? ''
  return {
    href: hydrated ? externalHref(link) : link,
    label: `Open on ${source.platform}`,
    sublabel: (disambiguate || isAwcCommentsSource(source)) && trimmedLabel ? trimmedLabel : null,
    applePodcasts: false,
  }
}
