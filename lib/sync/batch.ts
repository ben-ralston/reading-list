/**
 * PostgREST encodes `.in('col', ids)` as `?col=in.(id1,id2,...)`. With ~22-char
 * Spotify base62 IDs the URL grows quickly. Two layers limit how big it can be:
 * - undici's default ~16KB header limit on the Vercel function side (#143).
 * - Supabase's gateway (Kong/nginx) returns 414 "URI too long" earlier than that.
 *   Empirically, 200 IDs/req still hits 414 against the local stack.
 * 100 keeps each request URL under ~3KB with headroom and is comfortably below
 * both limits while only adding a few extra round trips per sync.
 */
export const SUPABASE_IN_CHUNK_SIZE = 100

export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${size}`)
  }
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}
