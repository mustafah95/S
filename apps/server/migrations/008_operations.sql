-- 008_operations — sync ledger and conflicts, backups, system updates, saved reports

-- One row per client operation id: guarantees an offline operation is applied at most once.
CREATE TABLE sync_operations (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_user_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  operation text NOT NULL,
  action text,
  payload jsonb NOT NULL,
  base_version integer,
  client_ts timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('applied', 'conflict', 'rejected', 'requires_review')),
  result jsonb,
  conflict_id uuid
);
CREATE INDEX sync_operations_entity_idx ON sync_operations (entity_type, entity_id);
CREATE INDEX sync_operations_received_idx ON sync_operations (received_at DESC);
CREATE INDEX sync_operations_device_idx ON sync_operations (device_id, received_at DESC);

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  branch_id uuid REFERENCES branches (id),
  kind text NOT NULL CHECK (kind IN ('version_conflict', 'reservation_overlap', 'invalid_transition', 'validation', 'duplicate_guest')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_server', 'resolved_client', 'resolved_custom', 'dismissed')),
  summary text NOT NULL,
  client_payload jsonb,
  server_snapshot jsonb,
  field_conflicts jsonb,
  device_id uuid,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution jsonb
);
CREATE INDEX sync_conflicts_open_idx ON sync_conflicts (status, created_at DESC);
CREATE INDEX sync_conflicts_entity_idx ON sync_conflicts (entity_type, entity_id);

CREATE TABLE backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  file_path text NOT NULL,
  size_bytes bigint,
  sha256 text,
  kind text NOT NULL CHECK (kind IN ('scheduled', 'manual', 'pre_update', 'pre_restore')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'deleted')),
  verify_status text CHECK (verify_status IN ('passed', 'failed')),
  verify_error text,
  verified_at timestamptz,
  external_copy_path text,
  app_version text,
  schema_version integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  created_by uuid
);
CREATE INDEX backups_started_idx ON backups (started_at DESC);

CREATE TABLE system_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_version text NOT NULL,
  to_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest jsonb,
  package_path text,
  package_sha256 text,
  backup_id uuid REFERENCES backups (id),
  migrations_applied integer[] NOT NULL DEFAULT '{}',
  is_rollback boolean NOT NULL DEFAULT false,
  initiated_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text
);
CREATE INDEX system_updates_started_idx ON system_updates (started_at DESC);

CREATE TABLE saved_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  dataset text NOT NULL,
  definition jsonb NOT NULL,
  is_shared boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE TRIGGER saved_reports_touch BEFORE INSERT OR UPDATE ON saved_reports FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();
