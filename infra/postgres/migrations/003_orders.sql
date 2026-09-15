-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID          NOT NULL REFERENCES users(id),
  payment_id  UUID,                                -- set once payment is linked
  status      TEXT          NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','paid','cancelled','refunded')),
  total       NUMERIC(18,2) NOT NULL CHECK (total > 0),
  currency    TEXT          NOT NULL DEFAULT 'USD',
  items       JSONB         NOT NULL DEFAULT '[]', -- [{sku, qty, unit_price}]
  metadata    JSONB         NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_user_id_idx    ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_payment_id_idx ON orders(payment_id);
