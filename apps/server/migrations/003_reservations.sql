-- 003_reservations — dining areas, tables, floor plan, reservations, table allocations, waitlist

CREATE TABLE areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches (id),
  name text NOT NULL,
  name_ar text,
  kind text NOT NULL CHECK (kind IN ('indoor', 'outdoor', 'vip', 'terrace', 'private_room', 'lounge', 'bar')),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  bookable_online boolean NOT NULL DEFAULT true,
  floor_plan jsonb NOT NULL DEFAULT '{"width":1200,"height":800,"elements":[]}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE INDEX areas_branch_idx ON areas (branch_id);
CREATE INDEX areas_sync_idx ON areas (sync_seq);
CREATE TRIGGER areas_touch BEFORE INSERT OR UPDATE ON areas FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches (id),
  area_id uuid NOT NULL REFERENCES areas (id),
  label text NOT NULL,
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  min_capacity integer NOT NULL CHECK (min_capacity BETWEEN 1 AND 100),
  max_capacity integer NOT NULL CHECK (max_capacity BETWEEN 1 AND 100),
  shape text NOT NULL DEFAULT 'square' CHECK (shape IN ('round', 'square', 'rectangle', 'booth', 'bar_stool', 'sofa')),
  pos_x real NOT NULL DEFAULT 40,
  pos_y real NOT NULL DEFAULT 40,
  width real NOT NULL DEFAULT 80,
  height real NOT NULL DEFAULT 80,
  rotation real NOT NULL DEFAULT 0,
  is_vip boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  bookable_online boolean NOT NULL DEFAULT true,
  combinable boolean NOT NULL DEFAULT true,
  manual_status text NOT NULL DEFAULT 'available'
    CHECK (manual_status IN ('available', 'cleaning', 'blocked', 'maintenance')),
  manual_status_reason text,
  manual_status_until timestamptz,
  manual_status_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  CHECK (min_capacity <= max_capacity)
);
CREATE UNIQUE INDEX restaurant_tables_label_uq ON restaurant_tables (branch_id, lower(label)) WHERE deleted_at IS NULL;
CREATE INDEX restaurant_tables_area_idx ON restaurant_tables (area_id);
CREATE INDEX restaurant_tables_sync_idx ON restaurant_tables (sync_seq);
CREATE TRIGGER restaurant_tables_touch BEFORE INSERT OR UPDATE ON restaurant_tables FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE table_combinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches (id),
  name text NOT NULL,
  table_ids uuid[] NOT NULL CHECK (cardinality(table_ids) >= 2),
  min_capacity integer NOT NULL,
  max_capacity integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  CHECK (min_capacity <= max_capacity)
);
CREATE INDEX table_combinations_sync_idx ON table_combinations (sync_seq);
CREATE TRIGGER table_combinations_touch BEFORE INSERT OR UPDATE ON table_combinations FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches (id),
  guest_id uuid REFERENCES guests (id),
  guest_name text,
  guest_phone text,
  business_date date NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 720),
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  area_id uuid REFERENCES areas (id),
  table_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending', 'confirmed', 'checked_in', 'seated', 'dining', 'completed', 'cancelled', 'no_show', 'rescheduled')),
  occasion text CHECK (occasion IS NULL OR occasion IN ('birthday', 'anniversary', 'engagement', 'wedding',
                       'business_dinner', 'proposal', 'graduation', 'family_event', 'other')),
  source text NOT NULL DEFAULT 'phone'
    CHECK (source IN ('phone', 'walk_in', 'online', 'widget', 'whatsapp', 'instagram', 'facebook', 'staff', 'event', 'other')),
  notes text,
  special_request text,
  deposit_amount numeric(14, 2),
  deposit_currency text,
  payment_status text NOT NULL DEFAULT 'not_required'
    CHECK (payment_status IN ('not_required', 'pending', 'paid', 'refunded', 'waived', 'failed')),
  payment_reference text,
  assigned_staff_id uuid REFERENCES users (id),
  checked_in_at timestamptz,
  seated_at timestamptz,
  dining_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  no_show_at timestamptz,
  rescheduled_from_id uuid REFERENCES reservations (id),
  rescheduled_to_id uuid REFERENCES reservations (id),
  confirmation_token uuid NOT NULL DEFAULT gen_random_uuid(),
  feedback_token uuid NOT NULL DEFAULT gen_random_uuid(),
  reminder_sent_at timestamptz,
  feedback_requested_at timestamptz,
  requires_review boolean NOT NULL DEFAULT false,
  review_reason text,
  origin text NOT NULL DEFAULT 'online' CHECK (origin IN ('online', 'offline', 'public', 'api', 'pos')),
  client_created_at timestamptz,
  pos_check_ref text,
  waitlist_entry_id uuid,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  CHECK (end_at > start_at)
);
CREATE UNIQUE INDEX reservations_code_uq ON reservations (code);
CREATE UNIQUE INDEX reservations_feedback_token_uq ON reservations (feedback_token);
CREATE INDEX reservations_branch_date_idx ON reservations (branch_id, business_date);
CREATE INDEX reservations_start_idx ON reservations (branch_id, start_at);
CREATE INDEX reservations_guest_idx ON reservations (guest_id, start_at DESC);
CREATE INDEX reservations_status_idx ON reservations (status);
CREATE INDEX reservations_review_idx ON reservations (branch_id) WHERE requires_review;
CREATE INDEX reservations_sync_idx ON reservations (sync_seq);
CREATE TRIGGER reservations_touch BEFORE INSERT OR UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

-- The single source of truth for table occupancy. The exclusion constraint makes double booking impossible at the
-- database level: two *active* allocations of the same table can never overlap in time, no matter how many devices
-- try concurrently. Periods include the post-reservation turnover buffer.
CREATE TABLE table_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid REFERENCES reservations (id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES restaurant_tables (id),
  branch_id uuid NOT NULL REFERENCES branches (id),
  period tstzrange NOT NULL,
  kind text NOT NULL DEFAULT 'reservation' CHECK (kind IN ('reservation', 'block')),
  active boolean NOT NULL DEFAULT true,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  released_at timestamptz,
  CHECK (NOT isempty(period)),
  CHECK (kind = 'block' OR reservation_id IS NOT NULL),
  CONSTRAINT table_allocations_no_overlap EXCLUDE USING gist (table_id WITH =, period WITH &&) WHERE (active)
);
CREATE INDEX table_allocations_reservation_idx ON table_allocations (reservation_id);
CREATE INDEX table_allocations_branch_period_idx ON table_allocations USING gist (branch_id, period) WHERE active;

CREATE TABLE reservation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations (id) ON DELETE CASCADE,
  type text NOT NULL,
  from_status text,
  to_status text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id uuid,
  device_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_events_res_idx ON reservation_events (reservation_id, at);

-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches (id),
  guest_id uuid REFERENCES guests (id),
  guest_name text NOT NULL,
  phone text,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 100),
  desired_time timestamptz,
  flexible_minutes integer NOT NULL DEFAULT 30,
  area_id uuid REFERENCES areas (id),
  priority integer NOT NULL DEFAULT 0,
  is_vip boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'seated', 'cancelled', 'expired')),
  quoted_wait_minutes integer,
  notes text,
  notified_at timestamptz,
  seated_at timestamptz,
  cancelled_at timestamptz,
  reservation_id uuid REFERENCES reservations (id),
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE INDEX waitlist_branch_status_idx ON waitlist_entries (branch_id, status, created_at);
CREATE INDEX waitlist_sync_idx ON waitlist_entries (sync_seq);
CREATE TRIGGER waitlist_entries_touch BEFORE INSERT OR UPDATE ON waitlist_entries FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();
