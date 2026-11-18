-- 006_marketing — message templates, notification outbox, segments, campaigns

CREATE TABLE message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'push')),
  language text NOT NULL CHECK (language IN ('ar', 'en')),
  subject text,
  body text NOT NULL,
  provider_template_name text,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  UNIQUE (key, channel, language)
);
CREATE TRIGGER message_templates_touch BEFORE INSERT OR UPDATE ON message_templates FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

-- Durable outbound message queue processed by the worker with FOR UPDATE SKIP LOCKED.
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'push')),
  recipient text NOT NULL,
  template_key text,
  language text,
  subject text,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  guest_id uuid REFERENCES guests (id),
  reservation_id uuid REFERENCES reservations (id),
  campaign_id uuid,
  branch_id uuid REFERENCES branches (id),
  is_marketing boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  provider_message_id text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox (next_attempt_at) WHERE status = 'pending';
CREATE UNIQUE INDEX notification_outbox_dedupe_uq ON notification_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notification_outbox_guest_idx ON notification_outbox (guest_id, created_at DESC);

CREATE TABLE segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  match text NOT NULL DEFAULT 'all' CHECK (match IN ('all', 'any')),
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE TRIGGER segments_touch BEFORE INSERT OR UPDATE ON segments FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  segment_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'push')),
  language text NOT NULL DEFAULT 'guest',
  subject text,
  body text NOT NULL,
  provider_template_name text,
  branch_id uuid REFERENCES branches (id),
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  cost numeric(14, 2) NOT NULL DEFAULT 0,
  attribution_days integer NOT NULL DEFAULT 14,
  sent_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  sync_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz
);
CREATE INDEX campaigns_status_idx ON campaigns (status, scheduled_at);
CREATE TRIGGER campaigns_touch BEFORE INSERT OR UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION sofia_touch_row();

ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_campaign_fk FOREIGN KEY (campaign_id) REFERENCES campaigns (id);

CREATE TABLE campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  guest_id uuid NOT NULL REFERENCES guests (id),
  outbox_id uuid REFERENCES notification_outbox (id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  skip_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, guest_id)
);
CREATE INDEX campaign_recipients_guest_idx ON campaign_recipients (guest_id);
