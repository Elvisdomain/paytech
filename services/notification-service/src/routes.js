'use strict';
const { Router } = require('express');
const { query, ValidationError } = require('@paytech/shared');

/**
 * Read-only HTTP API for the notification log.
 * Useful for debugging and observability — "did user X get notified?"
 */
module.exports = function notificationRoutes(logger) {
  const router = Router();

  // GET /notifications?userId=&limit=&offset=
  router.get('/', async (req, res, next) => {
    try {
      const { userId } = req.query;
      const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
      const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

      const result = userId
        ? await query(
            `SELECT id, event_id, event_type,
                    payload->>'paymentId' AS payment_id,
                    payload->>'userId'   AS user_id,
                    payload->>'amount'   AS amount,
                    sent_at, created_at
               FROM notification_log
              WHERE payload->>'userId' = $1
              ORDER BY created_at DESC
              LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
          )
        : await query(
            `SELECT id, event_id, event_type,
                    payload->>'paymentId' AS payment_id,
                    payload->>'userId'   AS user_id,
                    payload->>'amount'   AS amount,
                    sent_at, created_at
               FROM notification_log
              ORDER BY created_at DESC
              LIMIT $1 OFFSET $2`,
            [limit, offset]
          );

      res.json({ data: result.rows, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  // GET /notifications/:eventId  — look up a specific event
  router.get('/:eventId', async (req, res, next) => {
    try {
      const { eventId } = req.params;
      const result = await query(
        `SELECT id, event_id, event_type, payload, sent_at, created_at
           FROM notification_log
          WHERE event_id = $1`,
        [eventId]
      );

      res.json({ data: result.rows });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
