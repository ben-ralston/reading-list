// The content_items select shared by every queue read and single-row write
// response: the item, its sources and its Askwho Casts conversions.
export const SOURCES_SELECT = `
  *,
  sources:content_sources(id, platform, link, message_id, is_primary, created_at, external_id, progress, source_label),
  awc_conversions(id, kind, status, error, requested_at, updated_at)
`
