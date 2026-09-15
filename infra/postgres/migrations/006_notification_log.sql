-- Notification log — used by notification-service to deduplicate events.
-- Each (event_id, event_type) pair is processed at most once.
CREATE TABLE IF NOT EXISTS notification_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    TEXT        NOT NULL,           -- eventId from the published event
  event_type  TEXT        NOT NULL,           -- 'payment.succeeded' | 'payment.failed'
  payload     JSONB       NOT NULL,
  sent_at     TIMESTAMPTZ,                    -- NULL = claimed but not yet sent
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The idempotency constraint:
  -- even if the broker delivers the same message twice, only one row is inserted.
  UNIQUE (event_id, event_type)
);

CREATE INDEX IF NOT EXISTS notification_log_user_idx
  ON notification_log((payload->>'userId'));

CREATE INDEX IF NOT EXISTS notification_log_payment_idx
  ON notification_log((payload->>'paymentId'));
