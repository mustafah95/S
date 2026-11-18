-- 002_guest_crm — Guest 360° profile, notes and occasions

CREATE TABLE guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL,
  last_name text,
  preferred_name text,
  phone text,
  phone_normalized text,
  whatsapp text,
  email citext,
  birthday date,
  anniversary date,
  address text,
  company text,
  preferred_language text CHECK (preferred_language IS NULL OR preferred_language IN ('ar', 'en')),
  vip_level text NOT NULL DEFAULT 'standard'
    CHECK (vip_level IN ('standard', 'silver', 'gold', 'platinum', 'vip', 'vvip')),
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  allergies text[] NOT NULL DEFAULT '{}',
  dietary text[] NOT NULL DEFAULT '{}',
  marketing_consent boolean NOT NULL DEFAULT false,
  consent_channels jsonb NOT NULL DEFAULT '{"whatsapp":false,"sms":false,"email":false,"push":false}'::jsonb,
  consent_updated_at timestamptz,
  opted_out_at timestamptz,
  privacy_token uuid NOT NULL DEFAULT gen_random_uuid(),
  home_branch_id uuid REFERENCES branches (id),
  source text,
  loyalty_number text,
  loyalty_points integer NOT NULL DEFAULT 0,
  loyalty_lifetime_points integer NOT NULL DEFAULT 0,
  loyalty_tier_id uuid,
  merged_into_id uuid REFERENCES guests (id),
  anonymized_at timestamptz,
  -- aggregates maintained by refresh_guest_stats()
  first_visit_at timestamptz,
  last_visit_at timestamptz,
  visit_count integer NOT NULL DEFAULT 0,
  reservation_count integer NOT NULL DEFAULT 0,
  cancellation_count integer NOT NULL DEFAULT 0,
  no_show_count integer NOT NULL DEFAULT 0,
  invoice_count integer NOT NULL DEFAULT 0,
  total_spend numeric(14, 2) NOT NULL DEFAULT 0,
  avg_check numeric(14, 2) NOT NULL DEFAULT 0,
  max_check numeric(14, 2) NOT NULL DEFAULT 0,
  stats_refreshed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE INDEX guests_phone_idx ON guests (phone_normalized) WHERE deleted_at IS NULL;
CREATE INDEX guests_email_idx ON guests (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX guests_loyalty_number_uq ON guests (loyalty_number) WHERE loyalty_number IS NOT NULL;
CREATE UNIQUE INDEX guests_privacy_token_uq ON guests (privacy_token);
CREATE INDEX guests_name_trgm_idx ON guests
  USING gin ((lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(preferred_name, ''))) gin_trgm_ops);
CREATE INDEX guests_tags_idx ON guests USING gin (tags);
CREATE INDEX guests_last_visit_idx ON guests (last_visit_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX guests_spend_idx ON guests (total_spend DESC) WHERE deleted_at IS NULL;
CREATE INDEX guests_vip_idx ON guests (vip_level) WHERE deleted_at IS NULL;
CREATE INDEX guests_birthday_idx ON guests ((extract(month FROM birthday)), (extract(day FROM birthday))) WHERE birthday IS NOT NULL;
CREATE INDEX guests_sync_idx ON guests (sync_seq);
CREATE TRIGGER guests_touch BEFORE INSERT OR UPDATE ON guests FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE guest_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests (id),
  branch_id uuid REFERENCES branches (id),
  body text NOT NULL,
  kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'offline_merge', 'system', 'service')),
  is_pinned boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE INDEX guest_notes_guest_idx ON guest_notes (guest_id, created_at DESC);
CREATE INDEX guest_notes_sync_idx ON guest_notes (sync_seq);
CREATE TRIGGER guest_notes_touch BEFORE INSERT OR UPDATE ON guest_notes FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE guest_occasions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests (id),
  type text NOT NULL CHECK (type IN ('birthday', 'anniversary', 'engagement', 'wedding', 'business_dinner',
                                     'proposal', 'graduation', 'family_event', 'other')),
  date date NOT NULL,
  recurring boolean NOT NULL DEFAULT true,
  notes text,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE INDEX guest_occasions_guest_idx ON guest_occasions (guest_id);
CREATE TRIGGER guest_occasions_touch BEFORE INSERT OR UPDATE ON guest_occasions FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();
