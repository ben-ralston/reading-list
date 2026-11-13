/**
 * Progress normalization utilities for sync operations
 *
 * Handles various progress formats from external platforms:
 * - Percentage strings: "65%", "65"
 * - Decimal fractions: "0.65"
 * - Floats: "65.7"
 *
 * Normalizes to integer string (0-100) for consistent storage.
 */

/**
 * Normalize progress values from various formats to integer string (0-100)
 *
 * @param progress - Raw progress value from external platform
 * @returns Normalized progress as string "0" to "100", or null if invalid
 *
 * @example
 * normalizeProgress("65%")   // "65"
 * normalizeProgress("65.7")  // "66"
 * normalizeProgress("0.65")  // "65"
 * normalizeProgress("")      // null
 * normalizeProgress("abc")   // null
 */
export function normalizeProgress(progress: string | undefined | null): string | null {
  if (progress === undefined || progress === null || progress.trim() === '') {
    return null
  }

  // Remove % suffix and whitespace
  let value = progress.replace('%', '').trim()

  // Parse as float
  const num = parseFloat(value)
  if (isNaN(num)) {
    return null
  }

  // Handle decimal fractions (0.0 to 1.0 range → percentage)
  // Only treat as fraction if strictly between 0 and 1
  let percentage = num
  if (num > 0 && num < 1) {
    percentage = num * 100
  }

  // Round and clamp to 0-100
  const clamped = Math.round(Math.min(100, Math.max(0, percentage)))

  return String(clamped)
}

/**
 * Whether an incoming progress value is a strict numeric increase over the
 * stored one. Progress is a cross-source high-water mark (#192): a content
 * item can carry both a Spotify and a Substack source (e.g. the AI-voiced
 * podcast version of a post), and the hourly Spotify sync must not lower a
 * further-along reading position (nor vice versa). Values are TEXT in the DB,
 * so the comparison must be numeric — lexicographic would put "9" above "63".
 *
 * @param incoming - Normalized incoming progress ("0"–"100"), or null
 * @param current  - The item's stored progress (may be null/empty/junk)
 * @returns true only when incoming parses and exceeds a parseable current
 *          (an unparseable current counts as 0)
 */
export function isProgressIncrease(
  incoming: string | null,
  current: string | null | undefined
): boolean {
  if (incoming === null) return false
  const incomingNum = parseFloat(incoming)
  if (isNaN(incomingNum)) return false

  const currentNum = current == null ? NaN : parseFloat(current)
  if (isNaN(currentNum)) return true

  return incomingNum > currentNum
}

/**
 * Normalize status value to match database enum
 *
 * @param status - Raw status from external platform
 * @returns Normalized status or null if invalid
 */
export function normalizeStatus(
  status: string | undefined | null
): 'In Progress' | 'Completed' | null {
  if (!status) {
    return null
  }

  const normalized = status.toLowerCase().trim()

  if (normalized === 'completed' || normalized === 'finished' || normalized === 'done') {
    return 'Completed'
  }

  if (
    normalized === 'in progress' ||
    normalized === 'in_progress' ||
    normalized === 'inprogress' ||
    normalized === 'playing' ||
    normalized === 'listening' ||
    normalized === 'reading'
  ) {
    return 'In Progress'
  }

  return null
}
