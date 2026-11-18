-- Web Push: browsers of guests that asked to be notified about their reservations (and, with consent, offers).
-- An endpoint is a capability URL of the browser's push service; it is personal data: subscriptions are moved
-- when guest profiles are merged, deleted when a guest is anonymised and pruned after they are revoked.

CREATE TABLE guest_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests (id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (length(endpoint) <= 2000),
  -- the browser's P-256 public key ("p256dh") and authentication secret ("auth"), base64url
  public_key text NOT NULL CHECK (length(public_key) <= 200),
  auth_secret text NOT NULL CHECK (length(auth_secret) <= 100),
  language text CHECK (language IN ('ar', 'en')),
  user_agent text,
  reservation_id uuid REFERENCES reservations (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  failure_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  revoke_reason text
);

CREATE UNIQUE INDEX guest_push_subscriptions_endpoint_uq ON guest_push_subscriptions (endpoint);
CREATE INDEX guest_push_subscriptions_active_idx ON guest_push_subscriptions (guest_id) WHERE revoked_at IS NULL;
