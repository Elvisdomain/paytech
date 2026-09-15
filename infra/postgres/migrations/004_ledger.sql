-- Ledger accounts (one per user + system accounts)
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID,                                -- NULL for system accounts
  type        TEXT  NOT NULL CHECK (type IN ('customer','revenue','fees','escrow')),
  currency    TEXT  NOT NULL DEFAULT 'USD',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Double-entry ledger entries
-- Every financial event produces TWO rows (debit + credit) that net to zero.
-- idempotency_key ensures replayed events don't double-book.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   TEXT          NOT NULL,
  account_id        UUID          NOT NULL REFERENCES ledger_accounts(id),
  payment_id        UUID,
  direction         TEXT          NOT NULL CHECK (direction IN ('debit','credit')),
  amount            NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency          TEXT          NOT NULL DEFAULT 'USD',
  description       TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Uniqueness: one side of a double-entry per idempotency_key + account
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_idempotency_account_idx
  ON ledger_entries(idempotency_key, account_id, direction);

CREATE INDEX IF NOT EXISTS ledger_entries_payment_id_idx ON ledger_entries(payment_id);
CREATE INDEX IF NOT EXISTS ledger_entries_account_id_idx ON ledger_entries(account_id);

-- System accounts (seeded once)
INSERT INTO ledger_accounts (id, owner_id, type, currency) VALUES
  ('10000000-0000-0000-0000-000000000001', NULL, 'revenue', 'USD'),
  ('10000000-0000-0000-0000-000000000002', NULL, 'fees',    'USD'),
  ('10000000-0000-0000-0000-000000000003', NULL, 'escrow',  'USD')
ON CONFLICT DO NOTHING;
