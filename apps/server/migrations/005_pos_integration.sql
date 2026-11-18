-- 005_pos_integration — POS connections, imported invoices/items, sync runs, guest spending aggregates.
-- The POS / accounting system remains the financial source of truth: invoices are imported read-only.

CREATE TABLE pos_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches (id),
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('generic_rest', 'webhook', 'csv_import')),
  is_active boolean NOT NULL DEFAULT true,
  poll_interval_minutes integer NOT NULL DEFAULT 5,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets_enc text,
  last_sync_at timestamptz,
  last_cursor text,
  last_error text,
  last_error_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE TRIGGER pos_connections_touch BEFORE INSERT OR UPDATE ON pos_connections FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE pos_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES pos_connections (id),
  branch_id uuid NOT NULL REFERENCES branches (id),
  external_id text NOT NULL,
  invoice_number text,
  opened_at timestamptz,
  closed_at timestamptz NOT NULL,
  table_id uuid REFERENCES restaurant_tables (id),
  table_label text,
  reservation_id uuid REFERENCES reservations (id),
  guest_id uuid REFERENCES guests (id),
  covers integer,
  subtotal numeric(14, 2) NOT NULL DEFAULT 0,
  discount numeric(14, 2) NOT NULL DEFAULT 0,
  tax numeric(14, 2) NOT NULL DEFAULT 0,
  service_charge numeric(14, 2) NOT NULL DEFAULT 0,
  total numeric(14, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'IQD',
  exchange_rate numeric(14, 6) NOT NULL DEFAULT 1,
  total_base numeric(14, 2) NOT NULL,
  payment_method text,
  status text NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'void', 'refunded')),
  match_method text NOT NULL DEFAULT 'none'
    CHECK (match_method IN ('none', 'reservation_code', 'pos_check_ref', 'phone', 'loyalty_number', 'table_time', 'manual')),
  raw jsonb,
  imported_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  UNIQUE (connection_id, external_id)
);
CREATE INDEX pos_invoices_guest_idx ON pos_invoices (guest_id, closed_at DESC);
CREATE INDEX pos_invoices_res_idx ON pos_invoices (reservation_id);
CREATE INDEX pos_invoices_branch_closed_idx ON pos_invoices (branch_id, closed_at);
CREATE INDEX pos_invoices_number_idx ON pos_invoices (invoice_number);
CREATE TRIGGER pos_invoices_touch BEFORE INSERT OR UPDATE ON pos_invoices FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE pos_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES pos_invoices (id) ON DELETE CASCADE,
  external_item_id text,
  name text NOT NULL,
  category text,
  quantity numeric(12, 3) NOT NULL DEFAULT 1,
  unit_price numeric(14, 2) NOT NULL DEFAULT 0,
  discount numeric(14, 2) NOT NULL DEFAULT 0,
  total numeric(14, 2) NOT NULL DEFAULT 0
);
CREATE INDEX pos_invoice_items_invoice_idx ON pos_invoice_items (invoice_id);
CREATE INDEX pos_invoice_items_name_idx ON pos_invoice_items (lower(name));

CREATE TABLE pos_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES pos_connections (id) ON DELETE CASCADE,
  trigger text NOT NULL DEFAULT 'schedule',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  fetched integer NOT NULL DEFAULT 0,
  inserted integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  matched integer NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX pos_sync_runs_conn_idx ON pos_sync_runs (connection_id, started_at DESC);

ALTER TABLE loyalty_transactions ADD CONSTRAINT loyalty_txn_invoice_fk FOREIGN KEY (invoice_id) REFERENCES pos_invoices (id);

-- Recalculate a guest's visit and spending aggregates from reservations and POS invoices.
CREATE FUNCTION refresh_guest_stats(p_guest uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  i record;
BEGIN
  IF p_guest IS NULL THEN RETURN; END IF;
  SELECT
    count(*) FILTER (WHERE status IN ('seated', 'dining', 'completed')) AS visits,
    min(coalesce(seated_at, start_at)) FILTER (WHERE status IN ('seated', 'dining', 'completed')) AS first_visit,
    max(coalesce(seated_at, start_at)) FILTER (WHERE status IN ('seated', 'dining', 'completed')) AS last_visit,
    count(*) FILTER (WHERE status <> 'rescheduled') AS reservations,
    count(*) FILTER (WHERE status = 'cancelled') AS cancellations,
    count(*) FILTER (WHERE status = 'no_show') AS no_shows
  INTO r
  FROM reservations WHERE guest_id = p_guest AND deleted_at IS NULL;

  SELECT
    count(*) AS n,
    coalesce(sum(total_base), 0) AS total,
    coalesce(max(total_base), 0) AS max_total,
    count(*) FILTER (WHERE reservation_id IS NULL) AS unreserved_visits,
    min(closed_at) AS first_inv,
    max(closed_at) AS last_inv
  INTO i
  FROM pos_invoices WHERE guest_id = p_guest AND status = 'closed' AND deleted_at IS NULL;

  UPDATE guests SET
    visit_count = r.visits + i.unreserved_visits,
    first_visit_at = least(r.first_visit, i.first_inv),
    last_visit_at = greatest(r.last_visit, i.last_inv),
    reservation_count = r.reservations,
    cancellation_count = r.cancellations,
    no_show_count = r.no_shows,
    invoice_count = i.n,
    total_spend = i.total,
    max_check = i.max_total,
    avg_check = CASE WHEN i.n > 0 THEN round(i.total / i.n, 2) ELSE 0 END,
    stats_refreshed_at = now()
  WHERE id = p_guest;
END $$;
