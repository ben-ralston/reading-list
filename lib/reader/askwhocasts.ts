// Client-side handoff to Askwho Casts for converting a text article to
// produced audio (#226). The service is web-only — no mobile app, no share
// target, no URL parameter on the submit form (research 2026-07-16) — so the only
// handoff on every platform is copy the URL + open the app to paste it.
// Finished episodes come back via the private-feed cron (askwhocasts-sync),
// not through this module.

import { copyAndOpen, type CopyOpenResult } from './handoff'

export const ASKWHOCASTS_URL = 'https://app.askwhocasts.com/'

export async function sendToAskwhoCasts(url: string): Promise<CopyOpenResult> {
  return copyAndOpen(url, ASKWHOCASTS_URL)
}
