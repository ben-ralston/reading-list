// Batch loop behind scripts/regenerate-summaries.ts (#304). Kept separate from
// the script (which runs main() on import) so its bookkeeping is testable: a
// spend-limit stop must report the remaining items as not attempted, never ok.

export interface RegenerationFailure {
  id: number
  title: string
  error: string
}

export interface RegenerationResult {
  ok: number
  failed: RegenerationFailure[]
  notAttempted: number
}

export async function regenerateAll(
  items: { id: number; title: string }[],
  generate: (id: number) => Promise<unknown>,
  { delayMs = 1000, log = console.log }: { delayMs?: number; log?: (message: string) => void } = {},
): Promise<RegenerationResult> {
  let ok = 0
  const failed: RegenerationFailure[] = []
  for (const [i, item] of items.entries()) {
    log(`[${i + 1}/${items.length}] ${item.title}`)
    try {
      await generate(item.id)
      ok++
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      log(`  failed: ${error}`)
      failed.push({ id: item.id, title: item.title, error })
      // The account spend limit fails every later call too, so stop early.
      if (error.includes('usage limits')) break
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return { ok, failed, notAttempted: items.length - ok - failed.length }
}
