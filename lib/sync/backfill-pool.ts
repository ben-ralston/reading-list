/**
 * Bounded-concurrency worker pool shared by the backfill scripts (#167 feed
 * cards, #168 book covers). Runs `worker` over `items` with at most
 * `concurrency` in flight at once — polite to the sites/APIs we hit — and
 * returns results in input order regardless of completion order.
 */
export async function runConcurrent<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 5,
): Promise<R[]> {
  const limit = Math.max(1, concurrency)
  const results: R[] = new Array(items.length)
  let next = 0

  async function run() {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}
