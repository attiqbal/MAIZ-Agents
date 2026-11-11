-- Writes are now grouped: one transaction per client per round (src/storage/postgres.ts). now() is the
-- transaction's start time, so rows written in one round would share a timestamp and load back in id order.
-- clock_timestamp() is the moment of each statement, which keeps the order they were made in.
ALTER TABLE state_records ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE journal_entries ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE platform_records ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
ALTER TABLE workspaces ALTER COLUMN created_at SET DEFAULT clock_timestamp();
