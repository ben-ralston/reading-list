-- #171: track when a feed item was handed off to ElevenLabs Reader ("ElevenReader")
-- for text-to-speech listening. NULL = never sent. Optimistically set when the
-- user taps "Listen in ElevenReader". No backfill (NULL is correct for existing rows).
--
-- No GRANT needed: ALTER ... ADD COLUMN inherits content_items' existing Data API
-- grants (the explicit-grant convention applies to CREATE TABLE only).
ALTER TABLE content_items
ADD COLUMN sent_to_reader_at TIMESTAMPTZ;

COMMENT ON COLUMN content_items.sent_to_reader_at IS 'When the item was last sent to ElevenReader (#171). NULL = never sent.';
