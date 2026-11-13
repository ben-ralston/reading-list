-- Demo data for screenshots and local exploration. Everything here is invented:
-- the titles are well-known public essays, talks, podcast episodes and books,
-- but the statuses, progress, dates, picks, sync history and most links are made up.
--
-- Load into a running local stack (after `supabase start` has applied migrations):
--   eval "$(supabase status -o env)" && psql "$DB_URL" -f supabase/demo-seed.sql
-- Load it only into a fresh local stack: it empties the tables it fills.
--
-- Timestamps are relative to now(), so the home screen's picks are fresh whenever
-- this is loaded. It replaces all existing rows in the tables it touches.

SET search_path TO public;

TRUNCATE TABLE awc_conversions, curation_runs, sync_logs, rss_feeds, app_settings, content_items
  RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- Feed: articles, talks and podcast episodes (kind = 'feed')
-- ---------------------------------------------------------------------------
INSERT INTO content_items
  (id, kind, title, author, published_on, status, progress, word_count, duration_seconds, created_at, status_changed_at, pinned_at, shortlist_dismissed_at)
VALUES
  (1,  'feed', 'How to Do Great Work', 'Paul Graham', now() - interval '9 days', '', NULL, 11500, NULL, now() - interval '3 hours', NULL, now() - interval '2 hours', NULL),
  (2,  'feed', 'The Bitter Lesson', 'Rich Sutton', now() - interval '12 days', '', NULL, 1100, NULL, now() - interval '11 days', NULL, NULL, NULL),
  (3,  'feed', 'Meditations on Moloch', 'Scott Alexander', now() - interval '30 days', 'In Progress', '35% complete', 14000, NULL, now() - interval '20 days', now() - interval '2 days', NULL, NULL),
  (4,  'feed', 'Choose Boring Technology', 'Dan McKinley', now() - interval '6 days', '', NULL, 3400, NULL, now() - interval '6 days', NULL, NULL, NULL),
  (5,  'feed', 'Parse, Don''t Validate', 'Alexis King', now() - interval '4 days', '', NULL, 4300, NULL, now() - interval '4 days', NULL, NULL, NULL),
  (6,  'feed', 'The Rise of Worse Is Better', 'Richard P. Gabriel', now() - interval '18 days', '', NULL, 2000, NULL, now() - interval '18 days', NULL, NULL, NULL),
  (7,  'feed', 'Reflections on Trusting Trust', 'Ken Thompson', now() - interval '40 days', 'Completed', NULL, 2800, NULL, now() - interval '35 days', now() - interval '5 days', NULL, NULL),
  (8,  'feed', 'No Silver Bullet: Essence and Accident in Software Engineering', 'Fred Brooks', now() - interval '45 days', 'Completed', NULL, 6900, NULL, now() - interval '44 days', now() - interval '8 days', NULL, NULL),
  (9,  'feed', 'Maker''s Schedule, Manager''s Schedule', 'Paul Graham', now() - interval '50 days', 'Completed', NULL, 1300, NULL, now() - interval '49 days', now() - interval '12 days', NULL, NULL),
  (10, 'feed', '1,000 True Fans', 'Kevin Kelly', now() - interval '33 days', 'Skip', NULL, 2400, NULL, now() - interval '33 days', now() - interval '6 days', NULL, NULL),
  (11, 'feed', 'The Tail End', 'Tim Urban', now() - interval '2 days', '', NULL, 1900, NULL, now() - interval '2 days', NULL, NULL, NULL),
  (12, 'feed', 'You and Your Research', 'Richard Hamming', now() - interval '15 days', '', NULL, 9800, 2700, now() - interval '15 days', NULL, NULL, NULL),
  (13, 'feed', 'As We May Think', 'Vannevar Bush', now() - interval '22 days', '', NULL, 8100, NULL, now() - interval '22 days', NULL, NULL, now() - interval '3 days'),
  (14, 'feed', 'Things You Should Never Do, Part I', 'Joel Spolsky', now() - interval '7 days', '', NULL, 1500, NULL, now() - interval '7 days', NULL, NULL, NULL),
  (15, 'feed', 'The Cathedral and the Bazaar', 'Eric S. Raymond', now() - interval '26 days', 'In Progress', '80% complete', 12000, NULL, now() - interval '25 days', now() - interval '1 day', NULL, NULL),
  (16, 'feed', 'Simple Made Easy', 'Rich Hickey', now() - interval '10 days', '', NULL, NULL, 3700, now() - interval '10 days', NULL, NULL, NULL),
  (17, 'feed', 'The Grug Brained Developer', 'Grug', now() - interval '1 day', '', NULL, 6000, NULL, now() - interval '1 day', NULL, NULL, NULL),
  (18, 'feed', 'Politics and the English Language', 'George Orwell', now() - interval '60 days', 'Completed', NULL, 5300, NULL, now() - interval '58 days', now() - interval '20 days', NULL, NULL),
  (19, 'feed', 'Making Beliefs Pay Rent (in Anticipated Experiences)', 'Eliezer Yudkowsky', now() - interval '5 days', 'Awaiting comments', NULL, 1200, 540, now() - interval '5 days', now() - interval '10 hours', NULL, NULL),
  (20, 'feed', 'Programming as Theory Building', 'Peter Naur', now() - interval '14 days', '', NULL, 7000, NULL, now() - interval '14 days', NULL, NULL, NULL),
  (21, 'feed', 'What Is Code?', 'Paul Ford', now() - interval '8 days', '', NULL, 38000, NULL, now() - interval '8 days', NULL, NULL, NULL),
  (22, 'feed', 'The Website Obesity Crisis', 'Maciej Cegłowski', now() - interval '3 days', '', NULL, 7500, 3200, now() - interval '3 days', NULL, NULL, NULL),
  (23, 'feed', 'Heuristics That Almost Always Work', 'Astral Codex Ten', now() - interval '11 hours', '', NULL, 2100, NULL, now() - interval '10 hours', NULL, NULL, NULL),
  (24, 'feed', 'The rise and fall of peer review', 'Experimental History', now() - interval '36 hours', '', NULL, 4800, NULL, now() - interval '35 hours', NULL, NULL, NULL),
  (30, 'feed', 'Blueprint for Armageddon I', 'Dan Carlin''s Hardcore History', now() - interval '16 days', 'In Progress', '45% complete', NULL, 11640, now() - interval '16 days', now() - interval '18 hours', NULL, NULL),
  (31, 'feed', 'The Giant Pool of Money', 'This American Life', now() - interval '38 days', 'Completed', NULL, NULL, 3540, now() - interval '37 days', now() - interval '3 days', NULL, NULL),
  (32, 'feed', 'Colors', 'Radiolab', now() - interval '5 days', '', NULL, NULL, 3900, now() - interval '5 days', NULL, NULL, NULL),
  (33, 'feed', 'Costco', 'Acquired', now() - interval '2 days', '', NULL, NULL, 10800, now() - interval '2 days', NULL, NULL, NULL),
  (34, 'feed', 'The Case of the Missing Hit', 'Reply All', now() - interval '41 days', 'Completed', NULL, NULL, 3300, now() - interval '40 days', now() - interval '15 days', NULL, NULL),
  (35, 'feed', 'Fleetwood Mac - Go Your Own Way', 'Song Exploder', now() - interval '9 days', '', NULL, NULL, 1200, now() - interval '9 days', NULL, NULL, NULL),
  (36, 'feed', 'The Fibonacci Sequence', 'In Our Time', now() - interval '13 days', '', NULL, NULL, 2500, now() - interval '13 days', NULL, NULL, NULL),
  (37, 'feed', 'Structural Integrity', '99% Invisible', now() - interval '29 days', 'Skip', NULL, NULL, 1500, now() - interval '29 days', now() - interval '9 days', NULL, NULL),
  (38, 'feed', 'Nvidia Part I: The GPU Company', 'Acquired', now() - interval '20 days', 'In Progress', '20% complete', NULL, 9000, now() - interval '19 days', now() - interval '4 days', NULL, NULL),
  (39, 'feed', 'John Carmack: Doom, Quake, VR, AGI, Programming', 'Lex Fridman Podcast', now() - interval '6 days', '', NULL, NULL, 18900, now() - interval '6 days', NULL, NULL, NULL);

-- ---------------------------------------------------------------------------
-- Books (kind = 'book'); these still use an explicit queue order
-- ---------------------------------------------------------------------------
INSERT INTO content_items
  (id, kind, title, subtitle, series, author, isbn13, image_url, status, progress, queue_position, position_confirmed, created_at, status_changed_at)
VALUES
  (50, 'book', 'Designing Data-Intensive Applications', 'The Big Ideas Behind Reliable, Scalable, and Maintainable Systems', NULL, 'Martin Kleppmann', '9781449373320', 'https://covers.openlibrary.org/b/isbn/9781449373320-L.jpg', 'In Progress', '38% complete', 1, true, now() - interval '30 days', now() - interval '6 days'),
  (51, 'book', 'The Pragmatic Programmer', 'Your Journey to Mastery', NULL, 'David Thomas', '9780135957059', 'https://covers.openlibrary.org/b/isbn/9780135957059-L.jpg', '', NULL, 2, true, now() - interval '28 days', NULL),
  (52, 'book', 'Project Hail Mary', NULL, NULL, 'Andy Weir', '9780593135204', 'https://covers.openlibrary.org/b/isbn/9780593135204-L.jpg', 'In Progress', '72% complete', 3, true, now() - interval '21 days', now() - interval '1 day'),
  (53, 'book', 'Gödel, Escher, Bach', 'An Eternal Golden Braid', NULL, 'Douglas R. Hofstadter', '9780465026562', 'https://covers.openlibrary.org/b/isbn/9780465026562-L.jpg', '', NULL, 4, true, now() - interval '60 days', NULL),
  (54, 'book', 'A Philosophy of Software Design', NULL, NULL, 'John Ousterhout', '9781732102200', 'https://covers.openlibrary.org/b/isbn/9781732102200-L.jpg', '', NULL, 5, true, now() - interval '14 days', NULL),
  (55, 'book', 'The Left Hand of Darkness', NULL, 'Hainish Cycle #4', 'Ursula K. Le Guin', '9780441478125', 'https://covers.openlibrary.org/b/isbn/9780441478125-L.jpg', '', NULL, 6, true, now() - interval '12 days', NULL),
  (56, 'book', 'Piranesi', NULL, NULL, 'Susanna Clarke', '9781635575637', 'https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg', '', NULL, 7, false, now() - interval '9 days', NULL),
  (57, 'book', 'Thinking, Fast and Slow', NULL, NULL, 'Daniel Kahneman', '9780374533557', 'https://covers.openlibrary.org/b/isbn/9780374533557-L.jpg', '', NULL, 8, false, now() - interval '8 days', NULL),
  (58, 'book', 'The Design of Everyday Things', NULL, NULL, 'Don Norman', '9780465050659', 'https://covers.openlibrary.org/b/isbn/9780465050659-L.jpg', '', NULL, 9, false, now() - interval '5 days', NULL),
  (59, 'book', 'Children of Time', NULL, 'Children of Time #1', 'Adrian Tchaikovsky', '9780316452502', 'https://covers.openlibrary.org/b/isbn/9780316452502-L.jpg', '', NULL, 10, false, now() - interval '2 days', NULL),
  (60, 'book', 'The Martian', NULL, NULL, 'Andy Weir', '9780553418026', 'https://covers.openlibrary.org/b/isbn/9780553418026-L.jpg', 'Completed', NULL, NULL, false, now() - interval '120 days', now() - interval '40 days'),
  (61, 'book', 'Sapiens', 'A Brief History of Humankind', NULL, 'Yuval Noah Harari', '9780062316097', 'https://covers.openlibrary.org/b/isbn/9780062316097-L.jpg', 'Completed', NULL, NULL, false, now() - interval '200 days', now() - interval '90 days'),
  (62, 'book', 'The Mythical Man-Month', 'Essays on Software Engineering', NULL, 'Frederick P. Brooks Jr.', '9780201835953', 'https://covers.openlibrary.org/b/isbn/9780201835953-L.jpg', 'Completed', NULL, NULL, false, now() - interval '150 days', now() - interval '70 days'),
  (63, 'book', 'Dune', NULL, 'Dune #1', 'Frank Herbert', '9780441172719', 'https://covers.openlibrary.org/b/isbn/9780441172719-L.jpg', 'Completed', NULL, NULL, false, now() - interval '300 days', now() - interval '130 days'),
  (64, 'book', 'Infinite Jest', NULL, NULL, 'David Foster Wallace', '9780316066525', 'https://covers.openlibrary.org/b/isbn/9780316066525-L.jpg', 'Skip', NULL, NULL, false, now() - interval '90 days', now() - interval '25 days');

SELECT setval('content_items_id_seq', (SELECT MAX(id) FROM content_items));

-- ---------------------------------------------------------------------------
-- Sources: where each item can be opened. Episode and audiobook IDs are placeholders.
-- ---------------------------------------------------------------------------
INSERT INTO content_sources (content_item_id, platform, link, is_primary, external_id, source_label, progress) VALUES
  (1,  'Website',  'https://paulgraham.com/greatwork.html', true, NULL, NULL, NULL),
  (2,  'Website',  'http://www.incompleteideas.net/IncIdeas/BitterLesson.html', true, NULL, NULL, NULL),
  (3,  'Website',  'https://slatestarcodex.com/2014/07/30/meditations-on-moloch/', true, NULL, NULL, 35),
  (4,  'Website',  'https://boringtechnology.club/', true, NULL, NULL, NULL),
  (5,  'Website',  'https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/', true, NULL, NULL, NULL),
  (6,  'Website',  'https://www.dreamsongs.com/RiseOfWorseIsBetter.html', true, NULL, NULL, NULL),
  (7,  'Website',  'https://example.com/demo/reflections-on-trusting-trust', true, NULL, NULL, NULL),
  (8,  'Website',  'https://example.com/demo/no-silver-bullet', true, NULL, NULL, NULL),
  (9,  'Website',  'https://paulgraham.com/makersschedule.html', true, NULL, NULL, NULL),
  (10, 'Website',  'https://kk.org/thetechnium/1000-true-fans/', true, NULL, NULL, NULL),
  (11, 'Website',  'https://waitbutwhy.com/2015/12/the-tail-end.html', true, NULL, NULL, NULL),
  (12, 'Website',  'https://example.com/demo/you-and-your-research', true, NULL, NULL, NULL),
  (12, 'YouTube',  'https://www.youtube.com/watch?v=demo-hamming', false, NULL, NULL, NULL),
  (13, 'Website',  'https://example.com/demo/as-we-may-think', true, NULL, NULL, NULL),
  (14, 'Website',  'https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/', true, NULL, NULL, NULL),
  (15, 'Website',  'http://www.catb.org/~esr/writings/cathedral-bazaar/', true, NULL, NULL, 80),
  (16, 'YouTube',  'https://www.youtube.com/watch?v=demo-simple-made-easy', true, NULL, NULL, NULL),
  (17, 'Website',  'https://grugbrain.dev/', true, NULL, NULL, NULL),
  (18, 'Website',  'https://example.com/demo/politics-and-the-english-language', true, NULL, NULL, NULL),
  (19, 'LessWrong','https://www.lesswrong.com/posts/a7n8GdKiAZRX86T5A/making-beliefs-pay-rent-in-anticipated-experiences', true, NULL, NULL, NULL),
  (19, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000019', false, 'demo-spotify-19', NULL, 100),
  (20, 'Website',  'https://example.com/demo/programming-as-theory-building', true, NULL, NULL, NULL),
  (21, 'Website',  'https://example.com/demo/what-is-code', true, NULL, NULL, NULL),
  (22, 'Website',  'https://idlewords.com/talks/website_obesity.htm', true, NULL, NULL, NULL),
  (22, 'YouTube',  'https://www.youtube.com/watch?v=demo-website-obesity', false, NULL, NULL, NULL),
  (23, 'Substack', 'https://www.astralcodexten.com/p/heuristics-that-almost-always-work', true, NULL, NULL, NULL),
  (24, 'Substack', 'https://www.experimental-history.com/p/the-rise-and-fall-of-peer-review', true, NULL, NULL, NULL),
  (30, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000030', true, 'demo-spotify-30', NULL, 45),
  (31, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000031', true, 'demo-spotify-31', NULL, 100),
  (32, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000032', true, 'demo-spotify-32', NULL, NULL),
  (33, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000033', true, 'demo-spotify-33', NULL, NULL),
  (34, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000034', true, 'demo-spotify-34', NULL, 100),
  (35, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000035', true, 'demo-spotify-35', NULL, NULL),
  (36, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000036', true, 'demo-spotify-36', NULL, NULL),
  (37, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000037', true, 'demo-spotify-37', NULL, NULL),
  (38, 'Spotify',  'https://open.spotify.com/episode/demo0000000000000000038', true, 'demo-spotify-38', NULL, 20),
  (38, 'YouTube',  'https://www.youtube.com/watch?v=demo-nvidia-part-1', false, NULL, NULL, NULL),
  (39, 'YouTube',  'https://www.youtube.com/watch?v=demo-carmack', true, NULL, NULL, NULL),
  (50, 'Audible',  'https://www.audible.com/pd/DEMO000050', true, 'DEMO000050', NULL, 38),
  (50, 'Goodreads','https://www.goodreads.com/book/show/23463279', false, NULL, NULL, NULL),
  (51, 'Goodreads','https://www.goodreads.com/book/show/45280021', true, NULL, NULL, NULL),
  (52, 'Audible',  'https://www.audible.com/pd/DEMO000052', true, 'DEMO000052', NULL, 72),
  (53, 'Physical', NULL, true, NULL, NULL, NULL),
  (54, 'Goodreads','https://www.goodreads.com/book/show/39996759', true, NULL, NULL, NULL),
  (55, 'Audible',  'https://www.audible.com/pd/DEMO000055', true, 'DEMO000055', NULL, NULL),
  (56, 'Goodreads','https://www.goodreads.com/book/show/50202953', true, NULL, NULL, NULL),
  (57, 'Audible',  'https://www.audible.com/pd/DEMO000057', true, 'DEMO000057', NULL, NULL),
  (58, 'Physical', NULL, true, NULL, NULL, NULL),
  (59, 'Goodreads','https://www.goodreads.com/book/show/25499718', true, NULL, NULL, NULL),
  (60, 'Audible',  'https://www.audible.com/pd/DEMO000060', true, 'DEMO000060', NULL, 100),
  (61, 'Audible',  'https://www.audible.com/pd/DEMO000061', true, 'DEMO000061', NULL, 100),
  (62, 'Physical', NULL, true, NULL, NULL, NULL),
  (63, 'Audible',  'https://www.audible.com/pd/DEMO000063', true, 'DEMO000063', NULL, 100),
  (64, 'Goodreads','https://www.goodreads.com/book/show/6759', true, NULL, NULL, NULL);

-- ---------------------------------------------------------------------------
-- AI summaries on a few items (hand-written for the demo, not model output)
-- ---------------------------------------------------------------------------
UPDATE content_items SET
  summary = 'Great work comes from curiosity about a field you have real aptitude for, pursued at its frontier.',
  summary_generated_at = now() - interval '2 hours',
  summary_data = '{"one_liner": "Great work comes from curiosity about a field you have real aptitude for, pursued at its frontier.", "bullets": ["Pick work you have aptitude for and deep interest in, then learn enough to reach the edge of the field.", "Notice gaps at the frontier; the questions that seem odd to others are often the valuable ones.", "Consistency beats intensity: small daily progress compounds.", "Morale matters. Protect it by choosing good colleagues and ignoring prestige."], "source_access": "full_text", "model": "demo", "version": 2}'::jsonb
WHERE id = 1;

UPDATE content_items SET
  summary = 'Competition forces every actor to trade away what they value, and nobody in the system can stop it alone.',
  summary_generated_at = now() - interval '2 days',
  summary_data = '{"one_liner": "Competition forces every actor to trade away what they value, and nobody in the system can stop it alone.", "bullets": ["Uses Ginsberg''s Moloch as a name for multipolar traps.", "Walks through fourteen examples, from arms races to the two-income trap.", "Argues only coordination can escape the trap."], "source_access": "full_text", "model": "demo", "version": 2}'::jsonb
WHERE id = 3;

UPDATE content_items SET
  summary = 'How a single assassination in Sarajevo pulled the great powers into the First World War.',
  summary_generated_at = now() - interval '5 days',
  summary_data = '{"one_liner": "How a single assassination in Sarajevo pulled the great powers into the First World War.", "bullets": ["Sets out the alliance system and the mobilization timetables of July 1914.", "Follows the first weeks of fighting on the Western Front."], "source_access": "descriptions_only", "model": "demo", "version": 2}'::jsonb
WHERE id = 30;

-- ---------------------------------------------------------------------------
-- The latest curation run: the picks the home screen shows, with short reasons
-- ---------------------------------------------------------------------------
INSERT INTO curation_runs (started_at, finished_at, status, mode, model, items_considered, input_hash, picks) VALUES
  (now() - interval '26 hours', now() - interval '25 hours 57 minutes', 'succeeded', 'agent', 'demo', 22, 'demo-hash-1',
   '[{"id": 33, "reason": "New this week"}, {"id": 4, "reason": "Short and practical"}]'::jsonb),
  (now() - interval '21 minutes', now() - interval '18 minutes', 'succeeded', 'agent', 'demo', 24, 'demo-hash-2',
   '[{"id": 2,  "reason": "Ten minutes, and you keep citing it"},
     {"id": 33, "reason": "Long drive on Saturday"},
     {"id": 5,  "reason": "Pairs with the type-design work this week"},
     {"id": 12, "reason": "Has audio, good for a walk"},
     {"id": 32, "reason": "A lighter listen after Hardcore History"},
     {"id": 17, "reason": "Added yesterday, quick read"},
     {"id": 36, "reason": "Short episode"},
     {"id": 4,  "reason": "Short and practical"},
     {"id": 14, "reason": "Five minutes"},
     {"id": 22, "reason": "Talk and transcript both available"},
     {"id": 21, "reason": "Long. Save for a free afternoon"},
     {"id": 39, "reason": "Five hours. Split across the week"}]'::jsonb);

-- ---------------------------------------------------------------------------
-- RSS feeds (replaces the feeds the migrations seed) and recent sync history
-- ---------------------------------------------------------------------------
INSERT INTO rss_feeds (url, label, author_name, platform, feed_type, active, source, backfill_days, last_fetched_at, last_success_at, last_item_count, consecutive_errors, last_error, last_error_at) VALUES
  ('https://example.com/demo-feeds/paul-graham.rss',        'Paul Graham Essays',     'Paul Graham',          'Website',   'generic',   true,  'manual',        NULL, now() - interval '6 minutes', now() - interval '6 minutes', 12, 0, NULL, NULL),
  ('https://example.com/demo-feeds/astral-codex-ten/feed',  'Astral Codex Ten',       'Astral Codex Ten',     'Substack',  'substack',  true,  'substack_auto', NULL, now() - interval '6 minutes', now() - interval '6 minutes', 20, 0, NULL, NULL),
  ('https://example.com/demo-feeds/experimental-history/feed', 'Experimental History', 'Experimental History', 'Substack',  'substack',  true,  'substack_auto', 30,   now() - interval '6 minutes', now() - interval '6 minutes', 20, 0, NULL, NULL),
  ('https://example.com/demo-feeds/lesswrong-curated.rss',  'LessWrong (Curated)',    'LessWrong (Curated)',  'LessWrong', 'lesswrong', true,  'manual',        NULL, now() - interval '6 minutes', now() - interval '6 minutes', 50, 0, NULL, NULL),
  ('https://example.com/demo-feeds/idle-words.rss',         'Idle Words',             'Maciej Cegłowski',     'Website',   'generic',   true,  'manual',        NULL, now() - interval '6 minutes', now() - interval '3 days',    8,  4, 'Feed returned HTTP 503', now() - interval '6 minutes'),
  ('https://example.com/demo-feeds/wait-but-why.rss',       'Wait But Why',           'Tim Urban',            'Website',   'generic',   true,  'manual',        90,   now() - interval '6 minutes', now() - interval '6 minutes', 10, 0, NULL, NULL),
  ('https://example.com/demo-feeds/joel-on-software.rss',   'Joel on Software',       'Joel Spolsky',         'Website',   'generic',   false, 'manual',        NULL, now() - interval '40 days',   now() - interval '40 days',   25, 0, NULL, NULL);

INSERT INTO sync_logs (source, started_at, completed_at, status, items_processed, items_created, items_updated, items_skipped, feed_errors, error_message, metadata) VALUES
  ('rss',            now() - interval '6 minutes',  now() - interval '5 minutes 40 seconds', 'partial', 125, 1, 0, 124, 1, NULL, '{}'::jsonb),
  ('askwhocasts',    now() - interval '11 minutes', now() - interval '10 minutes 50 seconds','success', 4,   0, 0, 4,   0, NULL, '{}'::jsonb),
  ('rss',            now() - interval '21 minutes', now() - interval '20 minutes 41 seconds','success', 125, 0, 0, 125, 0, NULL, '{}'::jsonb),
  ('spotify',        now() - interval '48 minutes', now() - interval '47 minutes 30 seconds','success', 38,  1, 3, 34,  0, NULL, '{"back_catalog_skipped": 0}'::jsonb),
  ('apple_podcasts', now() - interval '52 minutes', now() - interval '51 minutes 58 seconds','success', 2,   0, 1, 1,   0, NULL, '{}'::jsonb),
  ('substack',       now() - interval '55 minutes', now() - interval '54 minutes 50 seconds','success', 16,  0, 2, 14,  0, NULL, '{}'::jsonb),
  ('audible',        now() - interval '9 hours',    now() - interval '8 hours 59 minutes',   'success', 41,  0, 2, 39,  0, NULL, '{}'::jsonb),
  ('substack_import',now() - interval '14 hours',   now() - interval '13 hours 59 minutes',  'success', 9,   0, 0, 9,   0, NULL, '{}'::jsonb),
  ('goodreads',      now() - interval '6 days',     now() - interval '6 days' + interval '12 seconds', 'success', 15, 15, 0, 0, 0, NULL, '{}'::jsonb);

SELECT kind, status, count(*) FROM content_items GROUP BY 1, 2 ORDER BY 1, 2;
