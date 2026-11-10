-- Platform-level records that belong to no client, such as the platform owner's price changes.
-- Only the platform role reads and writes them; the customer role (app_user) gets no access.
CREATE TABLE platform_records (
  kind text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
REVOKE ALL ON platform_records FROM app_user;

-- The client's sign-in email, so the platform owner can reach them from the clients screen.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_email text;
