'use strict';
const { Router } = require('express');
const { query, withTransaction, ValidationError, NotFoundError } = require('@paytech/shared');

module.exports = function orderRoutes(logger) {
  const router = Router();

  /**
   * POST /orders
   *
   * Create an order. The order starts in 'pending' status.
   * It becomes 'paid' once the payment-service publishes a
   * payment.succeeded event that references this order's id.
   *
   * Typical client flow:
   *   1. POST /api/orders              → get orderId
   *   2. POST /api/payments            → { orderId, amount, ... } + Idempotency-Key
   *   3. Order transitions to 'paid' automatically via the event consumer.
   */
  router.post('/', async (req, res, next) => {
    try {
      const userId = req.headers['x-authenticated-user-id'];
      if (!userId) throw new ValidationError('X-Authenticated-User-Id header missing');

      const { items, currency = 'USD', metadata } = req.body || {};

      if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError('items must be a non-empty array');
      }

      // Validate and compute total
      let total = 0;
      for (const item of items) {
        if (!item.sku || typeof item.qty !== 'number' || typeof item.unitPrice !== 'number') {
          throw new ValidationError('Each item must have sku, qty (number), and unitPrice (number)');
        }
        if (item.qty <= 0 || item.unitPrice <= 0) {
          throw new ValidationError('qty and unitPrice must be positive');
        }
        total += item.qty * item.unitPrice;
      }
      total = Math.round(total * 100) / 100;

      const result = await query(
        `INSERT INTO orders (user_id, total, currency, items, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, status, total, currency, items, metadata, created_at`,
        [userId, total, currency, JSON.stringify(items), JSON.stringify(metadata || {})]
      );

      const order = result.rows[0];
      logger.info({ orderId: order.id, userId, total }, 'order created');
      res.status(201).json({ data: order });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /orders/:id
   */
  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError('Invalid order id format');

      const result = await query(
        `SELECT id, user_id, payment_id, status, total, currency,
                items, metadata, created_at, updated_at
           FROM orders
          WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) throw new NotFoundError('Order', id);

      res.json({ data: result.rows[0] });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /orders
   * List orders for the authenticated user.
   */
  router.get('/', async (req, res, next) => {
    try {
      const userId = req.query.userId || req.headers['x-authenticated-user-id'];
      const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
      const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

      const result = await query(
        `SELECT id, user_id, payment_id, status, total, currency, created_at
           FROM orders
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      res.json({ data: result.rows, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /orders/:id/cancel
   * Cancel a pending order. Cannot cancel a paid order.
   */
  router.patch('/:id/cancel', async (req, res, next) => {
    try {
      const { id } = req.params;
      const userId = req.headers['x-authenticated-user-id'];

      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError('Invalid order id format');

      const result = await withTransaction(async (client) => {
        const row = await client.query(
          `SELECT id, status, user_id FROM orders WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (row.rows.length === 0) throw new NotFoundError('Order', id);
        const order = row.rows[0];

        if (order.user_id !== userId) {
          throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'FORBIDDEN' });
        }
        if (order.status === 'paid') {
          throw Object.assign(
            new Error('Cannot cancel a paid order — initiate a refund instead'),
            { statusCode: 409, code: 'CONFLICT' }
          );
        }
        if (order.status === 'cancelled') {
          return order; // idempotent cancel
        }

        const updated = await client.query(
          `UPDATE orders SET status = 'cancelled', updated_at = NOW()
            WHERE id = $1
            RETURNING id, status, updated_at`,
          [id]
        );
        return updated.rows[0];
      });

      logger.info({ orderId: id }, 'order cancelled');
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
