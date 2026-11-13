/**
 * Backfill window presets offered in the UI and accepted as the global default.
 *
 * Lives in its own side-effect-free module (no `@/lib/supabase` import) so the
 * client `feeds-client.tsx` can use it without pulling the server-only,
 * service-role Supabase client into the browser bundle (#164).
 */
export const ALLOWED_BACKFILL_PRESETS = [30, 90, 365] as const
