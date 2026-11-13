-- Migration: Drop backup table from earlier migration
-- Description: Remove queue_items_backup_pre_migration_005 - no longer needed
-- Date: 2025-12-14

DROP TABLE IF EXISTS queue_items_backup_pre_migration_005;
