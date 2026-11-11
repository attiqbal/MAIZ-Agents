-- MAIZ Agents: shared-database layout (privacy level 1).
-- Every customer-owned table carries workspace_id and is protected by
-- row-level security: a connection can only see rows for the workspace it
-- declared with  SELECT set_config('app.workspace_id', '<uuid>', true).
-- The app connects as the non-owner role "app_user", so RLS cannot be skipped.

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  privacy text NOT NULL DEFAULT 'shared',
  trial_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE employees (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  template_key text NOT NULL,
  name text NOT NULL
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  entry_date date NOT NULL,
  memo text NOT NULL,
  source text,
  reverses uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  account text NOT NULL,
  debit bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit > 0) <> (credit > 0))
);

CREATE TABLE energy_usage (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  employee_id uuid NOT NULL,
  day date NOT NULL,
  provider text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  cost_micro bigint NOT NULL,
  energy bigint NOT NULL,
  overtime boolean NOT NULL DEFAULT false
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  data jsonb
);

-- Books are append-only: no UPDATE or DELETE on entries, lines or the audit log.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- An entry must balance when the transaction commits.
CREATE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0) INTO d, c FROM journal_lines WHERE entry_id = NEW.id;
  IF d <> c OR d = 0 THEN RAISE EXCEPTION 'journal entry % does not balance (% vs %)', NEW.id, d, c; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Row-level security on every customer table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','employees','journal_entries','journal_lines','energy_usage','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY workspace_isolation ON %I USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspaces USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (true);

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user LOGIN; END IF;
END $$;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO app_user;
-- Creating customers is the platform's job (provisioning role), never a customer session's.
REVOKE INSERT ON workspaces FROM app_user;
GRANT UPDATE ON workspaces, memberships, employees TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
