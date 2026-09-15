'use strict';
const { Router } = require('express');
const { withTransaction, ValidationError, NotFoundError } = require('@paytech/shared');

// Well-known system account IDs (seeded in migration 004)
const SYSTEM_ACCOUNTS = {
  revenue: '10000000-0000-0000-0000-000000000001',
  fees:    '10000000-0000-0000-0000-000000000002',
  escrow:  '10000000-0000-0000-0000-000000000003',
};

module.exports = function ledgerRoutes(logger) {
  const router = Router();

  /**
   * POST /ledger/entries
   *
   * Records a double-entry bookkeeping event for a payment.
   * IDEMPOTENT — protected by the unique index on (idempotency_key, account_id, direction).
   * Replaying the same idempotency key returns the original entries unchanged.
   *
   * Body:
   *   {
   *     idempotencyKey: string,   // must equal payment's idempotency key
   *     paymentId:      UUID,
   *     userId:         UUID,
   *     amount:         number,
   *     currency:       string,
   *     type:           'charge' | 'refund'
   *   }
   *
   * Double-entry for a CHARGE:
   *   DEBIT  customer_account  (money leaves customer)
   *   CREDIT revenue_account   (money arrives at merchant)
   *
   * Double-entry for a REFUND:
   *   DEBIT  revenue_account   (money leaves merchant)
   *   CREDIT customer_account  (money returns to customer)
   */
  router.post('/entries', async (req, res, next) => {
    try {
      const { idempotencyKey, paymentId, userId, amount, currency = 'USD', type = 'charge' } = req.body || {};

      if (!idempotencyKey) throw new ValidationError('idempotencyKey is required');
      if (!paymentId)      throw new ValidationError('paymentId is required');
      if (!userId)         throw new ValidationError('userId is required');
      if (!amount || typeof amount !== 'number' || amount <= 0)
        throw new ValidationError('amount must be a positive number');
      if (!['charge', 'refund'].includes(type))
        throw new ValidationError('type must be charge or refund');

      const entries = await withTransaction(async (client) => {
        // Ensure the customer has a ledger account; create one if missing
        const accountResult = await client.query(
          `INSERT INTO ledger_accounts (owner_id, type, currency)
           VALUES ($1, 'customer', $2)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [userId, currency]
        );

        let customerAccountId;
        if (accountResult.rows.length > 0) {
          customerAccountId = accountResult.rows[0].id;
        } else {
          const existing = await client.query(
            `SELECT id FROM ledger_accounts WHERE owner_id = $1 AND currency = $2`,
            [userId, currency]
          );
          if (existing.rows.length === 0) throw new Error(`No ledger account for user ${userId}`);
          customerAccountId = existing.rows[0].id;
        }

        const revenueAccountId = SYSTEM_ACCOUNTS.revenue;

        // Determine debit/credit sides based on transaction type
        const [debitAccountId, creditAccountId] =
          type === 'charge'
            ? [customerAccountId, revenueAccountId]
            : [revenueAccountId, customerAccountId];

        // Insert both sides — the unique index makes this idempotent
        const insertEntry = (accountId, direction) =>
          client.query(
            `INSERT INTO ledger_entries
               (idempotency_key, account_id, payment_id, direction, amount, currency, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (idempotency_key, account_id, direction) DO NOTHING
             RETURNING id, account_id, direction, amount, currency, created_at`,
            [
              idempotencyKey,
              accountId,
              paymentId,
              direction,
              amount,
              currency,
              `${type} for payment ${paymentId}`,
            ]
          );

        const [debitResult, creditResult] = await Promise.all([
          insertEntry(debitAccountId,  'debit'),
          insertEntry(creditAccountId, 'credit'),
        ]);

        // If both rows were skipped (ON CONFLICT DO NOTHING) → idempotent replay
        const isReplay = debitResult.rows.length === 0 && creditResult.rows.length === 0;

        logger.info(
          { idempotencyKey, paymentId, amount, type, isReplay },
          isReplay ? 'ledger entry replay — returning cached' : 'ledger entries written'
        );

        // Return existing rows for replay case
        if (isReplay) {
          const existing = await client.query(
            `SELECT id, account_id, direction, amount, currency, created_at
               FROM ledger_entries
              WHERE idempotency_key = $1`,
            [idempotencyKey]
          );
          return { entries: existing.rows, replayed: true };
        }

        return {
          entries: [
            ...(debitResult.rows),
            ...(creditResult.rows),
          ],
          replayed: false,
        };
      });

      res.status(entries.replayed ? 200 : 201).json({ data: entries });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /ledger/accounts/:userId/balance
   * Returns the net balance for a user's ledger account.
   */
  router.get('/accounts/:userId/balance', async (req, res, next) => {
    try {
      const { userId } = req.params;

      const result = await withTransaction(async (client) => {
        const accountRow = await client.query(
          `SELECT id FROM ledger_accounts WHERE owner_id = $1`,
          [userId]
        );
        if (accountRow.rows.length === 0) {
          throw new NotFoundError('LedgerAccount', userId);
        }
        const accountId = accountRow.rows[0].id;

        const balanceRow = await client.query(
          `SELECT
             COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0) AS total_credited,
             COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount ELSE 0 END), 0) AS total_debited
           FROM ledger_entries
          WHERE account_id = $1`,
          [accountId]
        );

        const { total_credited, total_debited } = balanceRow.rows[0];
        return {
          userId,
          accountId,
          totalCredited: parseFloat(total_credited),
          totalDebited:  parseFloat(total_debited),
          // For a customer account: credits = incoming (refunds), debits = outgoing (charges)
          netBalance:    parseFloat(total_credited) - parseFloat(total_debited),
        };
      });

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /ledger/entries/:paymentId
   * Returns all ledger entries for a specific payment.
   */
  router.get('/entries/:paymentId', async (req, res, next) => {
    try {
      const { paymentId } = req.params;
      const result = await withTransaction(async (client) => {
        const rows = await client.query(
          `SELECT le.id, le.account_id, la.type AS account_type,
                  la.owner_id, le.direction, le.amount, le.currency,
                  le.description, le.created_at
             FROM ledger_entries le
             JOIN ledger_accounts la ON la.id = le.account_id
            WHERE le.payment_id = $1
            ORDER BY le.created_at`,
          [paymentId]
        );
        return rows.rows;
      });

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
