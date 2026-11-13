-- Fix security advisor warning: view should use SECURITY INVOKER (the default
-- in PostgreSQL, but Supabase flags views that call SECURITY DEFINER functions).
-- This ensures the view respects the querying user's RLS policies, not the
-- view creator's permissions.

ALTER VIEW author_engagement_scores SET (security_invoker = on);
