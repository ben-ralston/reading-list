-- Migration: Add app_settings table for storing OAuth tokens
-- Description: Key-value store for application settings like Spotify refresh token
-- Date: 2025-12-14

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_app_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_app_settings_updated_at();

-- Enable RLS (service role has full access by default)
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Add comment for documentation
COMMENT ON TABLE app_settings IS 'Key-value store for application settings like OAuth tokens';
