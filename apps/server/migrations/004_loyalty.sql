-- 004_loyalty — tiers, earning rules, rewards and the points ledger

CREATE TABLE loyalty_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_ar text,
  min_points integer NOT NULL DEFAULT 0 CHECK (min_points >= 0),
  multiplier numeric(5, 2) NOT NULL DEFAULT 1,
  benefits text,
  color text,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE TRIGGER loyalty_tiers_touch BEFORE INSERT OR UPDATE ON loyalty_tiers FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

ALTER TABLE guests ADD CONSTRAINT guests_loyalty_tier_fk FOREIGN KEY (loyalty_tier_id) REFERENCES loyalty_tiers (id);

CREATE TABLE loyalty_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('points_per_currency', 'visit', 'birthday', 'spend_threshold', 'referral')),
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE TRIGGER loyalty_rules_touch BEFORE INSERT OR UPDATE ON loyalty_rules FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE loyalty_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_ar text,
  type text NOT NULL CHECK (type IN ('discount_percent', 'discount_amount', 'free_item', 'voucher')),
  points_cost integer NOT NULL CHECK (points_cost > 0),
  value numeric(14, 2) NOT NULL DEFAULT 0,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE TRIGGER loyalty_rewards_touch BEFORE INSERT OR UPDATE ON loyalty_rewards FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

-- Append-only points ledger. idempotency_key guarantees a rule fires once per source (invoice, visit, birthday year).
CREATE TABLE loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests (id),
  branch_id uuid REFERENCES branches (id),
  type text NOT NULL CHECK (type IN ('earn', 'redeem', 'adjust', 'expire', 'bonus')),
  points integer NOT NULL,
  balance_after integer NOT NULL,
  reason text,
  rule_id uuid REFERENCES loyalty_rules (id),
  reward_id uuid REFERENCES loyalty_rewards (id),
  invoice_id uuid,
  reservation_id uuid REFERENCES reservations (id),
  idempotency_key text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE UNIQUE INDEX loyalty_txn_idem_uq ON loyalty_transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX loyalty_txn_guest_idx ON loyalty_transactions (guest_id, created_at DESC);
