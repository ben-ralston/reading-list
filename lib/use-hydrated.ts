import { useSyncExternalStore } from 'react'

const emptySubscribe = () => () => {}

/**
 * False during SSR and the hydration render, true from the first client
 * render after hydration. Use to gate markup that must differ between server
 * and client (e.g. the x-safari- href prefix in lib/links.ts) without causing
 * a React hydration-attribute mismatch.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )
}
