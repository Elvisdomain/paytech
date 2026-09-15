'use strict';
const { query, withTransaction } = require('@paytech/shared');
const { sendNotification } = require('./sender');

/**
 * Notification-service payment event consumer.
 *
 * ═══════════════════════════════════════════════════════════════
 * THE CORE DISTRIBUTED-SYSTEMS PROBLEM THIS FILE DEMONSTRATES
 * ═══════════════════════════════════════════════════════════════
 *
 * Scenario: Payment succeeds. Notification service crashes after
 * receiving the event but BEFORE sending the email and ACKing.
 *
 *   Timeline:
 *     T1: payment-service marks payment 'succeeded'  ✓
 *     T2: outbox relay publishes event to RabbitMQ   ✓
 *     T3: notification-service receives message       ✓
 *     T4: notification-service CRASHES               💥
 *     T5: broker redelivers (no ACK received)         ✓
 *     T6: notification-service restarts, re-receives ✓
 *     T7: sendNotification called again               ⚠️ duplicate?
 *
 * Without idempotency: the user gets two emails.
 * With idempotency (this implementation): second delivery is a no-op.
 *
 * Idempotency strategy:
 *   Store each processed event in `notification_log` keyed by
 *   (eventId, eventType). INSERT ... ON CONFLICT DO NOTHING inside
 *   the same transaction as the side-effect record.
 *   If the eventId already exists → skip sending.
 *
 * We also persist a local notification_log table so you can query
 * what was sent and replay / audit.
 */

async function handlePaymentEvent(event, logger) {
  const eventId   = event.eventId || event._outboxId;
  const eventType = event.status === 'succeeded' ? 'payment.succeeded' : 'payment.failed';

  if (!eventId) {
    logger.warn({ event }, 'received event without eventId — cannot guarantee idempotency, skipping');
    return;
  }

  // ── Idempotency check ─────────────────────────────────────────────────────
  // Attempt to claim this eventId. If already processed → skip.
  const claimed = await tryClaimEvent(eventId, eventType, event, logger);
  if (!claimed) {
    logger.info({ eventId, eventType }, 'notification event already processed — idempotent skip');
    return;
  }

  // ── Send the notification ─────────────────────────────────────────────────
  // NOTE: sendNotification is intentionally NOT inside the DB transaction.
  // If it fails here, the claimed row is already committed, so we won't
  // retry the send on redelivery. In a real system you'd want a
  // two-phase approach or a separate notification outbox.
  //
  // This is a deliberate demonstration of a residual failure window:
  //   "We claimed the event, but then the email provider was down."
  // The trade-off: prefer no duplicate emails over guaranteed delivery.
  // The right answer depends on your business requirements.
  try {
    await sendNotification({ event, eventType, logger });
    await markNotificationSent(eventId, logger);
  } catch (sendErr) {
    // Log and let the message be ACKed anyway (no retry for send failures).
    // Alternative: rethrow to NACK and retry via DLQ — your call.
    logger.error(
      { eventId, eventType, err: sendErr.message },
      'notification send failed — event was claimed, no retry'
    );
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function tryClaimEvent(eventId, eventType, payload, logger) {
  try {
    const result = await query(
      `INSERT INTO notification_log (event_id, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, event_type) DO NOTHING
       RETURNING id`,
      [eventId, eventType, JSON.stringify(payload)]
    );
    return result.rows.length > 0; // true = claimed, false = already processed
  } catch (err) {
    // Table might not exist on first boot before migrations run
    if (err.code === '42P01') {
      logger.warn('notification_log table not found — running without idempotency guard');
      return true;
    }
    throw err;
  }
}

async function markNotificationSent(eventId, logger) {
  await query(
    `UPDATE notification_log SET sent_at = NOW() WHERE event_id = $1`,
    [eventId]
  );
}

module.exports = { handlePaymentEvent };
