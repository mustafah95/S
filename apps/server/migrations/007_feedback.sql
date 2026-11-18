-- 007_feedback — post-visit feedback and complaint management

CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches (id),
  guest_id uuid REFERENCES guests (id),
  reservation_id uuid REFERENCES reservations (id),
  food_rating smallint CHECK (food_rating BETWEEN 1 AND 5),
  service_rating smallint CHECK (service_rating BETWEEN 1 AND 5),
  atmosphere_rating smallint CHECK (atmosphere_rating BETWEEN 1 AND 5),
  overall_rating smallint NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  comment text,
  suggestion text,
  is_complaint boolean NOT NULL DEFAULT false,
  channel text NOT NULL DEFAULT 'link' CHECK (channel IN ('link', 'staff', 'import')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX feedback_reservation_uq ON feedback (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX feedback_guest_idx ON feedback (guest_id);
CREATE INDEX feedback_branch_idx ON feedback (branch_id, submitted_at DESC);
CREATE TRIGGER feedback_touch BEFORE INSERT OR UPDATE ON feedback FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches (id),
  guest_id uuid REFERENCES guests (id),
  reservation_id uuid REFERENCES reservations (id),
  feedback_id uuid REFERENCES feedback (id),
  category text NOT NULL CHECK (category IN ('food', 'service', 'wait_time', 'cleanliness', 'billing', 'atmosphere',
                                             'reservation', 'staff', 'other')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description text NOT NULL,
  employee_name text,
  assigned_to uuid REFERENCES users (id),
  resolution text,
  compensation text,
  compensation_amount numeric(14, 2),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  follow_up_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id),
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE INDEX complaints_status_idx ON complaints (branch_id, status, created_at DESC);
CREATE INDEX complaints_guest_idx ON complaints (guest_id);
CREATE TRIGGER complaints_touch BEFORE INSERT OR UPDATE ON complaints FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();
