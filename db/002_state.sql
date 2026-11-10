-- Everything the services keep in memory, so it survives a restart.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'business',
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS base_currency text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'UTC';

ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS line_no integer NOT NULL DEFAULT 0;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS event_id uuid;

-- Small records that are replaced rather than appended: profile, energy plan, ledger accounts,
-- chat connections and links, encrypted chat bot tokens. Same row-level security as everything else.
CREATE TABLE state_records (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, id)
);
ALTER TABLE state_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_records FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON state_records
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON state_records TO app_user;
