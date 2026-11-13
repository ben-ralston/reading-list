-- Migration: Add signin_throttle table + RPCs
-- Description: DB-backed brute-force throttle for the sign-in action.
--   Vercel Fluid Compute has no durable per-instance memory, so the failed-
--   attempt counter must live in the DB. Single global row (single-user app).
-- Date: 2026-07-11
-- Related: GitHub Issue #206 (RLV-018)

-- Singleton counter row: id is CHECK-constrained to 1.
CREATE TABLE IF NOT EXISTS signin_throttle (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  failed_count INT NOT NULL DEFAULT 0,
  last_failed_at TIMESTAMPTZ
);

INSERT INTO signin_throttle (id) VALUES (1) ON CONFLICT DO NOTHING;

COMMENT ON TABLE signin_throttle IS
'Global failed sign-in counter for brute-force backoff (#206).
Singleton row (id=1). failed_count drives a capped exponential delay in
lib/signin-throttle.ts; counts older than 1 hour are treated as stale.';

-- Enable RLS (service-role-only policy; the app uses the service key, which
-- bypasses RLS — the policy is what blocks anon/authenticated PostgREST access)
ALTER TABLE signin_throttle ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON signin_throttle
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Explicit Data-API grant (CLAUDE.md rule: every table-creating migration must
-- grant, since Supabase is removing the ALTER DEFAULT PRIVILEGES auto-grant).
-- service_role only: this is a security table, RLS blocks anon/authenticated
-- regardless, and the app reaches it solely with the service key. Without this,
-- a re-apply after the auto-grant removal would silently disable the throttle
-- (it fails open), so make the load-bearing grant explicit.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.signin_throttle TO service_role;

-- Atomic increment with stale decay: one UPDATE, no read-then-write race
-- under parallel attempts. A failure more than 1 hour after the previous one
-- restarts the count at 1 (an abandoned attack must not leave the legitimate
-- user one typo away from a 15-minute tier days later).
CREATE OR REPLACE FUNCTION increment_signin_failures()
RETURNS TABLE (failed_count INT, last_failed_at TIMESTAMPTZ)
LANGUAGE sql
AS $$
  UPDATE signin_throttle
  SET
    failed_count = CASE
      WHEN signin_throttle.last_failed_at IS NULL
        OR signin_throttle.last_failed_at < now() - interval '1 hour'
      THEN 1
      ELSE signin_throttle.failed_count + 1
    END,
    last_failed_at = now()
  WHERE id = 1
  RETURNING signin_throttle.failed_count, signin_throttle.last_failed_at;
$$;

CREATE OR REPLACE FUNCTION reset_signin_throttle()
RETURNS void
LANGUAGE sql
AS $$
  UPDATE signin_throttle
  SET failed_count = 0, last_failed_at = NULL
  WHERE id = 1;
$$;

-- Functions get PUBLIC EXECUTE by default — revoke it so only service_role
-- can call these through PostgREST.
REVOKE EXECUTE ON FUNCTION increment_signin_failures() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reset_signin_throttle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION increment_signin_failures() TO service_role;
GRANT EXECUTE ON FUNCTION reset_signin_throttle() TO service_role;

-- POST-MIGRATION VERIFICATION
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'signin_throttle') THEN
    RAISE EXCEPTION 'signin_throttle table was not created';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM signin_throttle WHERE id = 1) THEN
    RAISE EXCEPTION 'signin_throttle singleton row was not inserted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'increment_signin_failures'
  ) THEN
    RAISE EXCEPTION 'increment_signin_failures function was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'reset_signin_throttle'
  ) THEN
    RAISE EXCEPTION 'reset_signin_throttle function was not created';
  END IF;

  RAISE NOTICE 'Migration completed successfully: signin_throttle table + RPCs created';
END $$;
