-- Idempotency keys table
-- Stores the result of any write operation keyed by client-supplied Idempotency-Key.
-- This is the canonical guard against double-charging.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key   TEXT        NOT NULL,
  service           TEXT        NOT NULL,          -- e.g. 'payment-service'
  request_hash      TEXT        NOT NULL,          -- SHA-256 of request body
  response_status   INT         NOT NULL,
  response_body     JSONB       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idempotency_key, service)
);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   TEXT        NOT NULL UNIQUE,
  user_id           UUID        NOT NULL REFERENCES users(id),
  order_id          UUID,                          -- optional link to an order
  amount            NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency          TEXT        NOT NULL DEFAULT 'USD',
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','processing','succeeded','failed','refunded')),
  fraud_score       NUMERIC(5,4),                  -- 0.0000 – 1.0000
  fraud_decision    TEXT        CHECK (fraud_decision IN ('approved','review','rejected')),
  failure_reason    TEXT,
  metadata          JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_user_id_idx ON payments(user_id);
CREATE INDEX IF NOT EXISTS payments_order_id_idx ON payments(order_id);
CREATE INDEX IF NOT EXISTS payments_status_idx   ON payments(status);
