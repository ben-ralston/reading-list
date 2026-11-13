/**
 * Fetch wrapper with automatic retry for transient failures.
 * Retries on network errors (TypeError) and 5xx server errors.
 * Does NOT retry 4xx client errors.
 */

interface FetchWithRetryOptions {
  retries?: number
  baseDelay?: number
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const { retries = 2, baseDelay = 500 } = options ?? {}

  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(input, init)

      // Don't retry client errors (4xx) — those are bugs, not transient
      if (response.status >= 500) {
        if (attempt < retries) {
          const delay = baseDelay * 2 ** attempt + Math.random() * baseDelay
          console.warn(
            `[fetchWithRetry] Server error ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries})`,
          )
          // Discard the unread body so (under Node/undici) its socket is
          // freed now rather than at garbage collection.
          await response.body?.cancel().catch(() => {})
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
      }

      return response
    } catch (error) {
      lastError = error

      // Only retry on TypeError (network failures like "Load failed")
      if (!(error instanceof TypeError)) {
        throw error
      }

      if (attempt < retries) {
        const delay = baseDelay * 2 ** attempt + Math.random() * baseDelay
        console.warn(
          `[fetchWithRetry] Network error, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries}):`,
          (error as Error).message,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  // Exhausted retries — throw the original error
  throw lastError
}
