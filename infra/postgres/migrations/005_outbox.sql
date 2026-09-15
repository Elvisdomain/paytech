-- Transactional outbox pattern
-- Events are written inside the same DB transaction as the state change,
-- then a relay process publishes them to RabbitMQ and marks them sent.
-- This prevents the "payment succeeded but notification never sent" problem.
CREATE TABLE IF NOT EXISTS outbox_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id  UUID        NOT NULL,              -- payment_id / order_id
  aggregate_type TEXT       NOT NULL,              -- 'payment' | 'order'
  event_type    TEXT        NOT NULL,              -- 'payment.succeeded' etc.
  payload       JSONB       NOT NULL,
  published     BOOLEAN     NOT NULL DEFAULT FALSE,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox_events(created_at) WHERE published = FALSE;
