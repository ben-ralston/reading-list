-- Migration: Scope RLS policies and privileges to service_role
-- Description: Locks the publishable anon key (and the unused authenticated
--   role) out of the content database. Fixes #205 (audit finding RLV-010).
-- Date: 2026-07-10
--
-- The app reaches Supabase exclusively with the service_role key
-- (lib/supabase.ts); iron-session middleware is the only auth layer. But:
--   * content_items / content_sources / feedback had `USING (true)` policies
--     with no TO clause, i.e. applying to PUBLIC including anon, and
--   * the foundational migration's ALTER DEFAULT PRIVILEGES granted ALL on
--     every table/sequence/function to anon and authenticated, and
--   * functions are executable by PUBLIC by default in Postgres, which is why
--     the "service_role only" delete_orphan_content_item (granted only to
--     service_role) was still callable with the anon key.
-- Net effect: an anon-key holder had full CRUD on the DB and could execute
-- every RPC, bypassing the app's auth entirely.

-- ============================================================================
-- 1. RE-SCOPE PERMISSIVE POLICIES TO service_role
-- ============================================================================
-- service_role bypasses RLS anyway; the explicit policy mirrors the sync_logs
-- pattern and keeps the intent visible in pg_policy. With no policy for any
-- other role, RLS default-denies them.

DROP POLICY IF EXISTS "Allow all operations with service key" ON public.content_items;
CREATE POLICY "Allow all operations with service key"
  ON public.content_items FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all operations with service key" ON public.content_sources;
CREATE POLICY "Allow all operations with service key"
  ON public.content_sources FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all operations with service key" ON public.feedback;
CREATE POLICY "Allow all operations with service key"
  ON public.feedback FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 2. REVOKE EXISTING OBJECT PRIVILEGES FROM anon / authenticated
-- ============================================================================
-- RLS already default-denies these roles after step 1, but the table grants
-- were the only thing letting requests reach RLS at all; revoking them turns
-- anon requests into hard permission-denied errors (defense in depth).
-- PUBLIC must be revoked on functions too: role-level revokes alone leave
-- anon with EXECUTE inherited from PUBLIC. All functions in the public schema
-- are this app's RPCs/trigger functions (extensions live in the extensions/
-- graphql/vault schemas), and each app RPC has an explicit service_role
-- grant, so service_role access is unaffected.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 3. STOP FUTURE OBJECTS FROM REGRESSING
-- ============================================================================
-- Remove anon/authenticated from the default privileges the foundational
-- migration set up, and strip the built-in PUBLIC EXECUTE default from new
-- functions. New tables/functions keep their service_role default grants.
-- Default privileges are per CREATOR role: this covers objects created by
-- postgres, the role all supabase/migrations/ DDL runs as. An object created
-- in public by any other role would keep Postgres's built-in PUBLIC EXECUTE
-- default (and we can't alter defaults for roles we're not a member of) —
-- so keep all DDL in migrations.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- POST-MIGRATION VERIFICATION
-- ============================================================================

-- All checks assert EFFECTIVE privileges via has_*_privilege(), which sees
-- access inherited through PUBLIC or role membership — unlike
-- information_schema's explicit-grant views, which would miss e.g. a
-- `GRANT ... TO PUBLIC`.

DO $$
DECLARE
  exposed_policies INT;
  exposed_tables INT;
  exposed_sequences INT;
  exposed_functions INT;
  service_role_locked_out INT;
BEGIN
  -- No policy in public may apply to PUBLIC (role oid 0), anon, or
  -- authenticated — whether alone or mixed into a longer role list.
  SELECT count(*) INTO exposed_policies
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND p.polroles && ARRAY[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid];
  IF exposed_policies > 0 THEN
    RAISE EXCEPTION 'RLS scope migration failed: % policies still apply to PUBLIC/anon/authenticated', exposed_policies;
  END IF;

  -- anon/authenticated must hold no effective table privileges in public.
  SELECT count(*) INTO exposed_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r(role_name)
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS pr(priv)
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND has_table_privilege(r.role_name, c.oid, pr.priv);
  IF exposed_tables > 0 THEN
    RAISE EXCEPTION 'RLS scope migration failed: % effective table privileges remain for anon/authenticated', exposed_tables;
  END IF;

  -- ...nor any effective sequence privileges.
  SELECT count(*) INTO exposed_sequences
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r(role_name)
  CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS pr(priv)
  WHERE n.nspname = 'public'
    AND c.relkind = 'S'
    AND has_sequence_privilege(r.role_name, c.oid, pr.priv);
  IF exposed_sequences > 0 THEN
    RAISE EXCEPTION 'RLS scope migration failed: % effective sequence privileges remain for anon/authenticated', exposed_sequences;
  END IF;

  -- ...nor execute any function in public.
  SELECT count(*) INTO exposed_functions
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r(role_name)
  WHERE n.nspname = 'public'
    AND has_function_privilege(r.role_name, p.oid, 'EXECUTE');
  IF exposed_functions > 0 THEN
    RAISE EXCEPTION 'RLS scope migration failed: anon/authenticated can still execute % functions', exposed_functions;
  END IF;

  -- service_role must retain access to the app's tables and RPCs. Checked
  -- per privilege: a comma-separated list in has_table_privilege() is ANY,
  -- not ALL.
  SELECT count(*) INTO service_role_locked_out
  FROM (
    SELECT 1
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv
    WHERE NOT has_table_privilege('service_role', 'public.content_items', priv)
    UNION ALL
    SELECT 1 WHERE NOT has_function_privilege('service_role', 'public.delete_orphan_content_item(bigint)', 'EXECUTE')
  ) locked;
  IF service_role_locked_out > 0 THEN
    RAISE EXCEPTION 'RLS scope migration failed: service_role lost required access';
  END IF;

  RAISE NOTICE 'RLS scope migration verified: anon/authenticated locked out, service_role intact';
END $$;
