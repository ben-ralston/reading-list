-- #304: structured AI summary: { one_liner, bullets, source_access, model, version }.
-- Nullable: NULL = legacy text-only summary in content_items.summary.
-- Column-only change: service_role's existing table grant covers it; no grants to
-- anon/authenticated (#205).
ALTER TABLE public.content_items ADD COLUMN summary_data JSONB;
