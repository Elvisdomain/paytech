'use strict';
const { withTransaction } = require('@paytech/shared');

/**
 * Handles payment events consumed from the 'order.payment.events' queue.
 *
 * This is an at-least-once consumer: the same event may arrive more than once
 * (e.g. broker redelivery after a crash). The handler must be idempotent.
 *
 * Idempotency strategy here:
 *   We use a conditional UPDATE:
 *     UPDATE orders SET status='paid' WHERE id=$orderId AND status='pending'
 *   If the order is already 'paid' (replay), the WHERE clause matches nothing
 *   and we return cleanly. No double-update, no error.
 *
 * Events handled:
 *   payment.succeeded → link payment_id to order, set status='paid'
 *   payment.failed    → leave order in 'pending' (client can retry payment)
 */
async function handlePaymentEvent(event, logger) {
  const { paymentId, orderId, status, userId, amount, currency } = event;

  if (!orderId) {
    // Payment was not linked to an order — nothing to do
    logger.debug({ paymentId, eventStatus: status }, 'payment event has no orderId, skipping');
    return;
  }

  if (status === 'succeeded') {
    await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE orders
            SET status     = 'paid',
                payment_id = $1,
                updated_at = NOW()
          WHERE id = $2
            AND status IN ('pending')   -- idempotency guard
          RETURNING id, status`,
        [paymentId, orderId]
      );

      if (result.rows.length === 0) {
        // Either order doesn't exist or it was already paid/cancelled
        // Check current state for logging clarity
        const current = await client.query(
          `SELECT id, status FROM orders WHERE id = $1`,
          [orderId]
        );
        const currentStatus = current.rows[0]?.status || 'not found';
        logger.info(
          { paymentId, orderId, currentStatus },
          'order not updated — already in terminal state or not found (idempotent replay)'
        );
      } else {
        logger.info({ paymentId, orderId, userId, amount, currency }, 'order marked as paid');
      }
    });
  } else if (status === 'failed') {
    // Payment failed — order stays pending so the user can retry.
    // In a real system you might add a failed_payment_count or TTL.
    logger.info({ paymentId, orderId }, 'payment failed, order remains pending');
  }
}

module.exports = { handlePaymentEvent };
