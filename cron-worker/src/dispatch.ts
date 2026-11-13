export const ENDPOINTS: Record<string, string> = {
  '*/15 * * * *': '/api/cron/rss-sync',
  '5-59/15 * * * *': '/api/cron/askwhocasts-sync',
  '15 * * * *': '/api/cron/spotify-sync',
  '0 8 * * *': '/api/cron/substack-import',
}

export function getEndpoint(cron: string): string | null {
  return ENDPOINTS[cron] ?? null
}
