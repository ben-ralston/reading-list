// Shared type definitions

export interface SyncResult {
  success: boolean
  processed: number
  created: number
  updated: number
  skipped: number
  error?: string
}
