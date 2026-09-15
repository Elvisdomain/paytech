'use strict';
const { v4: uuidv4 } = require('uuid');
const { withTransaction, insertOutboxEvent } = require('@paytech/shared');
const { checkFraud }        = require('./fraudClient');
const { recordLedgerEntry } = require('./ledgerClient');

/**
 * Core payment processing pipeline.
 *
 * This function is called from inside withIdempotency(), so the caller
 * already holds the idempotency_key row lock. It will only ever run once
 * per idempotency key — retries get the cached response from the
 * idempotency table.
 *
 * Pipeline:
 *   1. Persist payment row in 'pending' state
 *   2. Call fraud-service (synchronous, on critical path)
 *   3. If rejected → mark failed, emit payment.failed event, return
 *   4. Mark payment 'processing'
 *   5. Call ledger-service (synchronous, idempotent)
 *   6. Mark payment 'succeeded'
 *   7. Write outbox event (same DB transaction as step 6)
 *      → outbox relay publishes to RabbitMQ asynchronously
 *
 * Partial failure scenarios:
 *
 *   A) Crash between step 5 and 6:
 *      Payment stays 'processing'. The idempotency key was NOT stored
 *      (transaction rolled back), so the client can retry safely.
 *      On retry the ledger call is idempotent — no double-booking.
 *
 *   B) Ledger succeeds, DB crashes before outbox write:
 *      Same as A — retry re-runs the pipeline. Ledger call is a no-op
 *      (idempotent). Outbox event gets written this time.
 *
 *   C) Outbox event written, broker down:
 *      Relay keeps retrying until broker recovers. At-least-once.
 *
 *   D) Notification consumer crashes after receiving event but before ACK:
 *      Broker redelivers. Consumer must be idempotent (see notification-service).
 */
async function processPayment({ idempotencyKey, userId, orderId, amount, currency, metadata }, dbClient, logger) {
  const paymentId = uuidv4();

  // ── Step 1: insert payment as 'pending' ───────────────────────────────────
  await dbClient.query(
    `INSERT INTO payments
       (id, idempotency_key, user_id, order_id, amount, currency, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [paymentId, idempotencyKey, userId, orderId || null, amount, currency, JSON.stringify(metadata || {})]
  );

  logger.info({ paymentId, userId, amount }, 'payment created in pending state');

  // ── Step 2: fraud check (sync, on critical path) ──────────────────────────
  let fraudResult;
  try {
    fraudResult = await checkFraud({ paymentId, userId, amount, currency });
  } catch (fraudErr) {
    // Fraud service hard-failed and FRAUD_FAIL_OPEN=false
    await dbClient.query(
      `UPDATE payments SET status = 'failed', failure_reason = $1, updated_at = NOW() WHERE id = $2`,
      [fraudErr.message, paymentId]
    );
    await insertOutboxEvent(dbClient, {
      aggregateId:   paymentId,
      aggregateType: 'payment',
      eventType:     'payment.failed',
      payload:       buildEventPayload(paymentId, userId, amount, currency, 'failed', { reason: fraudErr.message }),
    });
    return buildResponse(paymentId, idempotencyKey, userId, amount, currency, 'failed', { reason: fraudErr.message });
  }

  // ── Step 3: fraud rejected ────────────────────────────────────────────────
  if (fraudResult.decision === 'rejected') {
    await dbClient.query(
      `UPDATE payments
          SET status = 'failed',
              fraud_score = $1,
              fraud_decision = $2,
              failure_reason = 'Rejected by fraud check',
              updated_at = NOW()
        WHERE id = $3`,
      [fraudResult.score, fraudResult.decision, paymentId]
    );
    await insertOutboxEvent(dbClient, {
      aggregateId:   paymentId,
      aggregateType: 'payment',
      eventType:     'payment.failed',
      payload:       buildEventPayload(paymentId, userId, amount, currency, 'failed', {
        reason: 'fraud_rejected',
        fraudScore: fraudResult.score,
        fraudReasons: fraudResult.reasons,
      }),
    });
    logger.warn({ paymentId, fraudScore: fraudResult.score }, 'payment rejected by fraud check');
    return buildResponse(paymentId, idempotencyKey, userId, amount, currency, 'failed', {
      fraudDecision: 'rejected',
      fraudScore: fraudResult.score,
    });
  }

  // ── Step 4: mark processing ───────────────────────────────────────────────
  await dbClient.query(
    `UPDATE payments
        SET status = 'processing',
            fraud_score = $1,
            fraud_decision = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [fraudResult.score, fraudResult.decision, paymentId]
  );

  // ── Step 5: record ledger entry ───────────────────────────────────────────
  // NOTE: This call happens OUTSIDE the DB transaction because ledger-service
  // is a separate service with its own DB. If this throws, the outer
  // withTransaction rolls back, idempotency key is NOT stored, and the client
  // can safely retry. The ledger call itself is idempotent.
  try {
    await recordLedgerEntry({ idempotencyKey, paymentId, userId, amount, currency, type: 'charge' });
  } catch (ledgerErr) {
    // Ledger failed — roll back the whole thing so the client can retry
    throw Object.assign(
      new Error(`Ledger recording failed: ${ledgerErr.message}`),
      { statusCode: 502, code: 'LEDGER_ERROR' }
    );
  }

  // ── Step 6 + 7: mark succeeded, write outbox event — ATOMIC ──────────────
  await dbClient.query(
    `UPDATE payments SET status = 'succeeded', updated_at = NOW() WHERE id = $1`,
    [paymentId]
  );

  await insertOutboxEvent(dbClient, {
    aggregateId:   paymentId,
    aggregateType: 'payment',
    eventType:     'payment.succeeded',
    payload:       buildEventPayload(paymentId, userId, amount, currency, 'succeeded', {
      orderId,
      fraudScore:    fraudResult.score,
      fraudDecision: fraudResult.decision,
    }),
  });

  logger.info({ paymentId, userId, amount }, 'payment succeeded');

  return buildResponse(paymentId, idempotencyKey, userId, amount, currency, 'succeeded', {
    fraudScore:    fraudResult.score,
    fraudDecision: fraudResult.decision,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildEventPayload(paymentId, userId, amount, currency, status, extra = {}) {
  return {
    eventId:   uuidv4(),
    paymentId,
    userId,
    amount,
    currency,
    status,
    occurredAt: new Date().toISOString(),
    ...extra,
  };
}

function buildResponse(paymentId, idempotencyKey, userId, amount, currency, status, extra = {}) {
  return {
    id: paymentId,
    idempotencyKey,
    userId,
    amount,
    currency,
    status,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

module.exports = { processPayment };
