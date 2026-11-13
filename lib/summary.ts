import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import {
  isBackCatalog,
  parseSummaryOutput,
  summaryDataFromDb,
  SUMMARY_OUTPUT_SCHEMA,
  type SummaryData,
  type SummaryDataDB,
} from './summary-data'

export const SUMMARY_MODEL = 'claude-opus-5-5'
const MAX_CONTINUATIONS = 5

// The final answer is the text after the last server-tool block: models may
// narrate ("I have enough to write…") before or between tool calls (#304).
export function extractFinalText(content: Anthropic.ContentBlock[]): string {
  let lastTool = -1
  content.forEach((block, i) => {
    if (block.type === 'server_tool_use' || block.type.endsWith('_tool_result')) lastTool = i
  })
  return content
    .slice(lastTool + 1)
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

export const SUMMARY_SYSTEM_PROMPT = `You write blurbs for a personal reading/listening queue. The reader scans many items and needs to decide in a few seconds whether — and when — to read or listen to each one.

Research first. You have web_search and web_fetch. Prefer fetching the article/text link directly (it usually has the full content). For podcast episodes with only a Spotify link, search for the episode's show notes, transcript, or write-ups. Be economical: a well-known piece may need one fetch; an obscure episode may need a couple of searches.

Writing rules:
- The reader already sees the title, author/publication, and platform on the card. Never restate them and never open with "This essay…", "In this episode…", or similar.
- Be concrete: state the actual claim, finding, argument, or story — not just the topic.
- Plain, dense language. No hype, no hedging filler. No preamble, no notes about your research.

Respond with a single JSON object with these fields:
- "one_liner": one sentence, at most 25 words. Shown inline on the queue card: the core claim, or what the reader gets from it.
- "bullets": 4-5 strings, each at most 20 words. Shown when the reader expands the card. Add what the one-liner doesn't say; never restate it. Cover the key arguments or findings, what's new, and practical cues for deciding when to read or listen (length, format, paywall, who it's for).
- "source_access": "full_text" only if you fetched the piece itself — the article text, a transcript, or the publisher's detailed act/segment breakdown. Show-notes blurbs, press releases, and search snippets are "descriptions_only".

If you could only find descriptions, still write the blurb from what you found. If you found nothing substantive at all, set "one_liner" to "Couldn't access the content: " followed by the little that is known, "bullets" to [], and "source_access" to "descriptions_only". Never apologize and never suggest the reader look elsewhere.`

export interface ContentSourceInfo {
  platform: string
  link: string
}

export function buildPromptMessages(title: string, sources: ContentSourceInfo[]): Anthropic.MessageParam[] {
  let userContent = `Title: ${title}`

  if (sources.length === 1) {
    userContent += `\nLink: ${sources[0].link}`
  } else if (sources.length > 1) {
    const spotifySources = sources.filter(s => s.platform === 'Spotify')
    const otherSources = sources.filter(s => s.platform !== 'Spotify')

    if (otherSources.length > 0 && spotifySources.length > 0) {
      for (const s of otherSources) {
        userContent += `\nArticle/text link (preferred — more likely to have full content): ${s.link}`
      }
      for (const s of spotifySources) {
        userContent += `\nAudio version (Spotify): ${s.link}`
      }
    } else {
      for (const s of sources) {
        userContent += `\nLink (${s.platform}): ${s.link}`
      }
    }
  }

  return [{ role: 'user' as const, content: userContent }]
}

const client = new Anthropic()

// Newer web tools (dynamic filtering). Cast: server-tool shapes may lag the SDK types.
const SUMMARY_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
] as unknown as Anthropic.Tool[]

interface GenerateSummaryOptions {
  skipExisting?: boolean
  // Ingest-triggered (background) generation: skip back-catalog items (#304/#305).
  auto?: boolean
}

interface GenerateSummaryResult {
  summary: string
  summaryData: SummaryData | null
  generatedAt: string
}

async function requestSummary(
  initial: Anthropic.MessageParam[],
): Promise<{ content: Anthropic.ContentBlock[]; stopReason: string | null }> {
  let messages = initial
  const content: Anthropic.ContentBlock[] = []
  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    // Built as a variable and cast: output_config and the thinking-free
    // Opus 5.5 params may be newer than this SDK's request types.
    const params = {
      model: SUMMARY_MODEL,
      max_tokens: 32000, // thinking is always on for Opus 5.5 and counts against this
      system: SUMMARY_SYSTEM_PROMPT,
      messages,
      tools: SUMMARY_TOOLS,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUMMARY_OUTPUT_SCHEMA } },
    }
    const message = await client.messages.stream(params as unknown as Anthropic.MessageStreamParams).finalMessage()
    content.push(...message.content)
    const stopReason = message.stop_reason as string | null
    if (stopReason !== 'pause_turn') return { content, stopReason }
    messages = [...messages, { role: 'assistant', content: message.content }]
  }
  throw new Error('Summary generation did not finish within the pause_turn limit')
}

export async function generateSummary(
  contentItemId: number,
  options?: GenerateSummaryOptions,
): Promise<GenerateSummaryResult> {
  const { data: item, error: itemError } = await supabase
    .from('content_items')
    .select('id, title, summary, summary_data, summary_generated_at, published_on, created_at')
    .eq('id', contentItemId)
    .single()

  if (itemError || !item) {
    throw new Error(`Content item ${contentItemId} not found`)
  }

  const existing: GenerateSummaryResult = {
    summary: item.summary ?? '',
    summaryData: summaryDataFromDb(item.summary_data),
    generatedAt: item.summary_generated_at ?? '',
  }

  // Skip if already has summary and skipExisting is true
  if (options?.skipExisting && item.summary) return existing

  if (options?.auto && isBackCatalog(item.published_on, item.created_at)) {
    console.log(`[Summary] Skipped back-catalog item "${item.title}" (id: ${contentItemId}, published ${item.published_on})`)
    return existing
  }

  // Fetch all source links
  const { data: sources } = await supabase
    .from('content_sources')
    .select('platform, link')
    .eq('content_item_id', contentItemId)

  const sourceInfos: ContentSourceInfo[] = (sources ?? [])
    .filter((s): s is { platform: string; link: string } => !!s.link)

  console.log(`[Summary] Generating for "${item.title}" (id: ${contentItemId})`)
  if (sourceInfos.length > 0) {
    console.log(`[Summary] Sources: ${sourceInfos.map(s => `${s.platform}: ${s.link}`).join(', ')}`)
  }

  const startTime = Date.now()
  const { content, stopReason } = await requestSummary(buildPromptMessages(item.title, sourceInfos))

  // Log tool usage
  for (const block of content) {
    // Dynamic-filtering tools also emit code_execution blocks; log only the web calls.
    if (block.type !== 'server_tool_use') continue
    const input = (block as { input?: Record<string, unknown> }).input
    if (block.name === 'web_search') console.log(`[Summary] Tool: web_search, query: "${input?.query}"`)
    else if (block.name === 'web_fetch') console.log(`[Summary] Tool: web_fetch, url: "${input?.url}"`)
  }

  if (stopReason === 'max_tokens') {
    throw new Error(`Summary generation was truncated (max_tokens) for content item ${contentItemId}`)
  }
  if (stopReason === 'refusal') {
    throw new Error(`Summary generation was refused for content item ${contentItemId}`)
  }

  const output = parseSummaryOutput(extractFinalText(content))
  const summaryDataDb: SummaryDataDB = { ...output, model: SUMMARY_MODEL, version: 2 }
  const generatedAt = new Date().toISOString()

  console.log(`[Summary] Result: ${output.bullets.length} bullets, ${output.source_access}, ${Date.now() - startTime}ms`)

  // Store in database: summary mirrors the one-liner so legacy readers keep working.
  const { error: updateError } = await supabase
    .from('content_items')
    .update({ summary: output.one_liner, summary_data: summaryDataDb, summary_generated_at: generatedAt })
    .eq('id', contentItemId)

  if (updateError) {
    throw new Error(`Failed to store summary: ${updateError.message}`)
  }

  return { summary: output.one_liner, summaryData: summaryDataFromDb(summaryDataDb), generatedAt }
}
