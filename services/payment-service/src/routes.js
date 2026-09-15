'use strict';
const { Router } = require('express');
const { withIdempotency, query, ValidationError, NotFoundError } = require('@paytech/shared');
const { processPayment } = require('./processor');

const SERVICE = 'payment-service';

module.exports = function paymentRoutes(logger) {
  const router = Router();

  /**
   * POST /payments
   *
   * Create (or idempotently replay) a payment.
   *
   * Required headers:
   *   Idempotency-Key: <client-generated UUID or random string, 8–255 chars>
   *   X-Authenticated-User-Id: <uuid>  (injected by api-gateway)
   *
   * Body:
   *   { amount, currency?, orderId?, metadata? }
   *
   * Idempotency guarantee:
   *   The same Idempotency-Key always returns the same response.
   *   The charge is executed at most once regardless of how many times
   *   the client retries (network timeouts, 5xx errors, etc.).
   *
   *   Implementation:
   *     withIdempotency() wraps the handler in a DB transaction and
   *     inserts into idempotency_keys at commit time. A concurrent
   *     duplicate request blocks on the row lock until the first
   *     request completes, then gets the cached response.
   */
  router.post('/', async (req, res, next) => {
    try {
      const idempotencyKey = req.headers['idempotency-key'];
      const userId         = req.headers['x-authenticated-user-id'];

      if (!userId) {
        throw new ValidationError('X-Authenticated-User-Id header missing — route through api-gateway');
      }

      const { amount, currency = 'USD', orderId, metadata } = req.body || {};

      if (amount == null)              throw new ValidationError('amount is required');
      if (typeof amount !== 'number')  throw new ValidationError('amount must be a number');
      if (amount <= 0)                 throw new ValidationError('amount must be positive');
      if (amount > 1_000_000)          throw new ValidationError('amount exceeds maximum of 1,000,000');

      const result = await withIdempotency({
        key:         idempotencyKey,
        service:     SERVICE,
        requestBody: req.body,
        handler:     (dbClient) =>
          processPayment(
            { idempotencyKey, userId, orderId, amount, currency, metadata },
            dbClient,
            logger
          ).then((paymentData) => ({ status: 201, body: { data: paymentData } })),
      });

      if (result.replayed) {
        // Tell the client their request was a duplicate — same response, no side-effects
        res.setHeader('Idempotent-Replayed', 'true');
      }

      res.status(result.replayed ? 200 : result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /payments/:id
   * Fetch a single payment by its UUID.
   */
  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;

      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ValidationError('Invalid payment id format');
      }

      const result = await query(
        `SELECT id, idempotency_key, user_id, order_id, amount, currency,
                status, fraud_score, fraud_decision, failure_reason,
                metadata, created_at, updated_at
           FROM payments
          WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new NotFoundError('Payment', id);
      }

      res.json({ data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /payments
   * List payments, optionally filtered by userId.
   */
  router.get('/', async (req, res, next) => {
    try {
      const userId = req.query.userId || req.headers['x-authenticated-user-id'];
      const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
      const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

      const result = userId
        ? await query(
            `SELECT id, idempotency_key, user_id, order_id, amount, currency,
                    status, fraud_decision, created_at
               FROM payments
              WHERE user_id = $1
              ORDER BY created_at DESC
              LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
          )
        : await query(
            `SELECT id, idempotency_key, user_id, order_id, amount, currency,
                    status, fraud_decision, created_at
               FROM payments
              ORDER BY created_at DESC
              LIMIT $1 OFFSET $2`,
            [limit, offset]
          );

      res.json({ data: result.rows, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
