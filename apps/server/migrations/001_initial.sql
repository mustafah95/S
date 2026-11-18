-- 001_initial — core platform: branches, users, roles, sessions, settings, files, audit, events, sync infrastructure
-- All operational tables share the "standard columns": version, sync_seq, created_at/by, updated_at/by, deleted_at.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Global change-feed sequence used by device synchronisation (see docs/ARCHITECTURE.md §11).
CREATE SEQUENCE sofia_sync_seq;

-- Every write to a synchronised table takes a shared advisory lock for the rest of its transaction and receives a
-- fresh sync_seq. A pull takes the same lock exclusively for an instant to read a high-water mark that has no
-- in-flight (uncommitted) lower sequence numbers — so devices never miss a row that committed late.
CREATE FUNCTION sofia_touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(73010001);
  NEW.sync_seq := nextval('sofia_sync_seq');
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION sofia_sync_high_water_mark() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE hwm bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(73010001);
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO hwm FROM sofia_sync_seq;
  RETURN hwm;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code citext NOT NULL,
  name text NOT NULL,
  name_ar text,
  address text,
  phone text,
  email citext,
  timezone text NOT NULL DEFAULT 'Asia/Baghdad',
  currency text NOT NULL DEFAULT 'IQD' CHECK (currency IN ('IQD', 'USD')),
  operating_hours jsonb NOT NULL,
  reservation_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  capacity integer CHECK (capacity IS NULL OR capacity >= 0),
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX branches_code_uq ON branches (code) WHERE deleted_at IS NULL;
CREATE INDEX branches_sync_idx ON branches (sync_seq);
CREATE TRIGGER branches_touch BEFORE INSERT OR UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE branch_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  date date NOT NULL,
  reason text,
  periods jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (branch_id, date)
);

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name_en text NOT NULL,
  name_ar text NOT NULL,
  all_branches boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  seeded_permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username citext NOT NULL,
  email citext,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role_id uuid NOT NULL REFERENCES roles (id),
  is_active boolean NOT NULL DEFAULT true,
  preferred_language text NOT NULL DEFAULT 'ar' CHECK (preferred_language IN ('ar', 'en')),
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_required boolean NOT NULL DEFAULT false,
  mfa_secret_enc text,
  mfa_recovery_hashes text[] NOT NULL DEFAULT '{}',
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_username_uq ON users (username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE TRIGGER users_touch BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE user_branches (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  refresh_hash text NOT NULL UNIQUE,
  device_id uuid,
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_family_idx ON user_sessions (family_id);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  name text,
  user_agent text,
  last_ip inet,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_sync_at timestamptz,
  client_version text
);

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  branch_id uuid REFERENCES branches (id) ON DELETE CASCADE,
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX app_settings_key_uq ON app_settings (key, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TRIGGER app_settings_touch BEFORE INSERT OR UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

-- Uploaded files (logo, login background, favicon) live in the database so every backup is complete.
CREATE TABLE stored_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  sha256 text NOT NULL,
  purpose text NOT NULL DEFAULT 'general',
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

-- ---------------------------------------------------------------------------------------------------------------
-- Append-only audit trail. Row-level security permits INSERT and SELECT only: no UPDATE/DELETE policy exists,
-- so the runtime role cannot alter history even if a grant is misconfigured.
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  offline_user_id uuid,
  device_id uuid,
  ip inet,
  user_agent text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  branch_id uuid,
  old_values jsonb,
  new_values jsonb,
  meta jsonb
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_at_idx ON audit_logs (at DESC);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, at DESC);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (true);
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (true);

-- Categorised operational log (security, sync, update, backup, integration, error) shown in the log viewer.
CREATE TABLE system_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  category text NOT NULL,
  message text NOT NULL,
  data jsonb,
  process_role text
);
CREATE INDEX system_events_cat_idx ON system_events (category, at DESC);
CREATE INDEX system_events_at_idx ON system_events (at DESC);

-- Staff in-app notifications (VIP arrival, sync conflict, backup failure, waitlist match …)
CREATE TABLE in_app_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES branches (id) ON DELETE CASCADE,
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  permission text,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  title text NOT NULL,
  body text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX in_app_notifications_created_idx ON in_app_notifications (created_at DESC);

CREATE TABLE in_app_notification_reads (
  notification_id uuid NOT NULL REFERENCES in_app_notifications (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);
