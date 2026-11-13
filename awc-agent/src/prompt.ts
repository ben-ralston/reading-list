// Builds the awc-agent prompt from awc-agent/prompt.md (#317).
import type { AwcClaim } from '../../lib/awc/conversions-repo'
import { MAX_CREDITS, type CommentsScript } from './comments-script'

const GENERATE =
  'Click "Make the episode" (the button shows the price, e.g. "32 credits"), wait until the Library lists the episode as being made or the credit balance drops by the price, then write `AWC_STAGE: generating`.'
const DRY_RUN_GENERATE =
  'DRY RUN: do NOT click "Make the episode". Note the credits shown on it, then finish with outcome "failed", error "dry run — episode not made".'
const AUTO_CAST =
  'Click "Auto Cast" (its button shows the price, about 2 credits for a long script; casting by hand can\'t cover this many lines). Wait up to two minutes for "Auto Cast placed N lines across M characters": the status line then reads "M characters · N lines". N should equal `quotations`; a different M is fine. If lines are still uncast ("N to cast") and there are at most 20, open each one\'s "Who?" menu and choose "Narrator (not speech)". If there are more than 20, or Auto Cast fails, stop: outcome "failed", path "script", error "auto cast incomplete".'
const DRY_RUN_AUTO_CAST =
  'DRY RUN: do NOT click "Auto Cast", because it costs credits. Finish now with outcome "failed", path "script", error "dry run — episode not made".'

// Item fields come from RSS/DB and are attacker-influenced. JSON-encoding
// them (with <, >, & escaped) means no title can close the data block or
// inject template markers, whatever characters it contains.
function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

function itemJson(claim: AwcClaim): string {
  return safeJson({
    title: claim.title,
    author: claim.author,
    url: claim.sourceUrl,
    word_count: claim.wordCount,
    expected_credits_if_full_text: claim.wordCount ? Math.round(claim.wordCount / 150) : null,
  })
}

// Drop the skill file's YAML frontmatter (trigger metadata for the CLI).
export function skillReference(skillMarkdown: string): string {
  return skillMarkdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

export function buildPrompt(
  template: string,
  claim: AwcClaim,
  opts: { dryRun: boolean; skillReference: string },
): string {
  const values: Record<string, string> = {
    ITEM_JSON: itemJson(claim),
    GENERATE_STEP: opts.dryRun ? DRY_RUN_GENERATE : GENERATE,
    SKILL_REFERENCE: opts.skillReference || '(reference notes unavailable)',
  }
  // Single pass: substituted values are never re-scanned for markers.
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => values[key] ?? m)
}

// #368. The script itself never enters the prompt: it goes on the clipboard, so
// the model can't shorten it. The agent gets only what it needs to check the paste.
export function buildCommentsPrompt(
  template: string,
  script: CommentsScript,
  opts: { dryRun: boolean; dryRunCast: boolean },
): string {
  const values: Record<string, string> = {
    SCRIPT_JSON: safeJson({
      episode_title: script.episodeTitle,
      opening: script.opening,
      ending: script.ending,
      word_count: script.words,
      quotations: script.quotations,
      characters: script.characters,
      max_credits: MAX_CREDITS,
    }),
    AUTO_CAST_STEP: opts.dryRun && !opts.dryRunCast ? DRY_RUN_AUTO_CAST : AUTO_CAST,
    GENERATE_STEP: opts.dryRun ? DRY_RUN_GENERATE : GENERATE,
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => values[key] ?? m)
}
