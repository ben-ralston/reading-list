-- Seed data for local development (Multi-Source Schema)
-- Run with: supabase db reset (applies migrations + seed)
--
-- This seed works with the new content_items + content_sources schema.
-- After migration 005, use this instead of the old queue_items seed.

-- Set search path to public schema
SET search_path TO public;

-- Clear existing data (CASCADE deletes content_sources automatically)
TRUNCATE TABLE content_items RESTART IDENTITY CASCADE;

-- Insert test data into content_items
INSERT INTO content_items (id, title, author, published_on, status, queue_position, position_confirmed, progress, created_at, updated_at) VALUES

-- Active items with confirmed queue positions
(1, 'The Creative Act: A Way of Being', 'Rick Rubin', '2024-01-15', 'In Progress', 1, true, 'Chapter 12 of 78', NOW(), NOW()),
(2, 'Deep Work', 'Cal Newport', '2024-01-10', '', 2, true, NULL, NOW(), NOW()),
(3, 'Atomic Habits', 'James Clear', '2024-01-08', '', 3, true, NULL, NOW(), NOW()),

-- Items with AI-suggested positions (not confirmed)
(4, 'How to Build a Second Brain', 'Tiago Forte', '2024-11-20', '', 4, false, NULL, NOW(), NOW()),
(5, 'The Psychology of Money', 'Morgan Housel', '2024-11-18', '', 5, false, NULL, NOW(), NOW()),

-- Items without queue positions (will sort by published_on)
(6, 'Thinking in Systems', 'Donella Meadows', '2024-11-15', '', NULL, false, NULL, NOW(), NOW()),
(7, 'The Mom Test', 'Rob Fitzpatrick', '2024-11-12', '', NULL, false, NULL, NOW(), NOW()),
(8, 'Shape Up', 'Ryan Singer', '2024-11-10', '', NULL, false, NULL, NOW(), NOW()),
(9, 'Staff Engineer', 'Will Larson', '2024-11-08', '', NULL, false, NULL, NOW(), NOW()),
(10, 'An Elegant Puzzle', 'Will Larson', '2024-11-05', '', NULL, false, NULL, NOW(), NOW()),

-- Podcast episodes
(11, 'Lex Fridman #400 - Elon Musk', 'Lex Fridman', '2024-11-01', '', NULL, false, NULL, NOW(), NOW()),
(12, 'Huberman Lab: Sleep Optimization', 'Andrew Huberman', '2024-10-28', '', NULL, false, NULL, NOW(), NOW()),
(13, 'All-In Podcast E150', 'All-In Team', '2024-10-25', '', NULL, false, NULL, NOW(), NOW()),

-- Completed items (for testing filters - these should NOT appear in main queue)
(14, 'Sapiens', 'Yuval Noah Harari', '2024-06-01', 'Completed', NULL, false, 'Finished', NOW(), NOW()),
(15, 'Zero to One', 'Peter Thiel', '2024-05-15', 'Completed', NULL, false, 'Great insights on startups', NOW(), NOW()),

-- Skipped items (for testing filters - these should NOT appear in main queue)
(16, 'Bad Book Title', 'Some Author', '2024-04-01', 'Skip', NULL, false, NULL, NOW(), NOW()),
(17, 'Not Interested', 'Another Author', '2024-03-15', 'Skip', NULL, false, NULL, NOW(), NOW());

-- Insert corresponding sources into content_sources
-- Each item gets one primary source
INSERT INTO content_sources (id, content_item_id, platform, link, message_id, is_primary, created_at) VALUES

-- Audible sources
(1, 1, 'Audible', 'https://audible.com/pd/The-Creative-Act-Audiobook/B0BTS1M8NZ', NULL, true, NOW()),
(2, 2, 'Audible', 'https://audible.com/pd/Deep-Work-Audiobook/B0189PVAWY', NULL, true, NOW()),
(3, 3, 'Audible', 'https://audible.com/pd/Atomic-Habits-Audiobook/1524779261', NULL, true, NOW()),
(5, 5, 'Audible', 'https://audible.com/pd/The-Psychology-of-Money-Audiobook/B08D9TXF3H', NULL, true, NOW()),
(10, 10, 'Audible', 'https://audible.com/pd/An-Elegant-Puzzle-Audiobook/0593148347', NULL, true, NOW()),
(14, 14, 'Audible', 'https://audible.com/pd/Sapiens-Audiobook/B0741F5Y4M', NULL, true, NOW()),

-- Substack source
(4, 4, 'Substack', 'https://fortelabs.com/blog/basboverview/', 'msg_abc123', true, NOW()),

-- Kindle sources
(6, 6, 'Kindle', 'https://amazon.com/dp/B005VSRFEA', NULL, true, NOW()),
(7, 7, 'Kindle', 'https://amazon.com/dp/B01H4G2J1U', 'msg_ghi789', true, NOW()),
(9, 9, 'Kindle', 'https://staffeng.com/book', NULL, true, NOW()),
(15, 15, 'Kindle', 'https://amazon.com/dp/B00J6YBOFQ', NULL, true, NOW()),
(16, 16, 'Kindle', 'https://example.com/skip1', NULL, true, NOW()),

-- Web sources
(8, 8, 'Web', 'https://basecamp.com/shapeup', NULL, true, NOW()),
(17, 17, 'Web', 'https://example.com/skip2', NULL, true, NOW()),

-- Podcast/Streaming sources
(11, 11, 'Spotify', 'https://open.spotify.com/episode/example1', NULL, true, NOW()),
(12, 12, 'YouTube', 'https://youtube.com/watch?v=example1', NULL, true, NOW()),
(13, 13, 'Spotify', 'https://open.spotify.com/episode/example2', NULL, true, NOW());

-- Update sequences to match inserted IDs
SELECT setval('content_items_id_seq', (SELECT MAX(id) FROM content_items));
SELECT setval('content_sources_id_seq', (SELECT MAX(id) FROM content_sources));

-- Add a multi-source item for testing (same content, multiple platforms)
-- This demonstrates the deduplication feature
INSERT INTO content_items (title, author, published_on, status, queue_position, position_confirmed, progress)
VALUES ('Multi-Source Test Item', 'Test Author', '2024-12-01', '', NULL, false, NULL);

INSERT INTO content_sources (content_item_id, platform, link, is_primary)
SELECT currval('content_items_id_seq'), 'Spotify', 'https://spotify.com/multi-source-test', true;

INSERT INTO content_sources (content_item_id, platform, link, is_primary)
SELECT currval('content_items_id_seq'), 'YouTube', 'https://youtube.com/multi-source-test', false;

INSERT INTO content_sources (content_item_id, platform, link, is_primary)
SELECT currval('content_items_id_seq'), 'Web', 'https://example.com/multi-source-test', false;

-- Verify seed data
SELECT
  'content_items' as table_name,
  COUNT(*) as count
FROM content_items
UNION ALL
SELECT
  'content_sources' as table_name,
  COUNT(*) as count
FROM content_sources;

-- Show status distribution
SELECT
  status,
  COUNT(*) as count,
  COUNT(queue_position) as with_position
FROM content_items
GROUP BY status
ORDER BY status;

-- Show multi-source item
SELECT
  ci.title,
  COUNT(cs.id) as source_count,
  string_agg(cs.platform, ', ') as platforms
FROM content_items ci
JOIN content_sources cs ON ci.id = cs.content_item_id
GROUP BY ci.id, ci.title
HAVING COUNT(cs.id) > 1;
