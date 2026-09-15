'use strict';
const { publishEvent } = require('./amqp');

/**
 * Writes an event to the outbox table inside an already-open DB client/transaction.
 * The outbox relay (outboxRelay.js) polls for unpublished rows and publishes them.
 *
 * This is the core of the Transactional Outbox pattern:
 *   - The outbox INSERT happens in the same transaction as the business state change.
 *   - If the transaction commits → event will eventually be published.
 *   - If the transaction rolls back → event row is gone too. No phantom events.
 */
async function insertOutboxEvent(client, { aggregateId, aggregateType, eventType, payload }) {
  const result = await client.query(
    `INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [aggregateId, aggregateType, eventType, JSON.stringify(payload)]
  );
  return result.rows[0].id;
}

/**
 * Relay loop: polls the outbox table every `intervalMs` for unpublished events
 * and publishes them to RabbitMQ, then marks them published.
 *
 * In a real system this would run as a separate process or use Postgres LISTEN/NOTIFY.
 * Here it runs in-process for simplicity.
 *
 * At-least-once guarantee:
 *   If the broker publish succeeds but the DB UPDATE fails (crash window),
 *   the event will be published again on the next poll. Consumers must be idempotent.
 */
function startOutboxRelay(pool, logger, intervalMs = 2000) {
  async function relay() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock unpublished rows so concurrent relays don't double-publish
      const { rows } = await client.query(
        `SELECT id, aggregate_id, event_type, payload
           FROM outbox_events
          WHERE published = FALSE
          ORDER BY created_at
          LIMIT 50
            FOR UPDATE SKIP LOCKED`
      );

      for (const row of rows) {
        const routingKey = row.event_type;           // e.g. 'payment.succeeded'
        try {
          await publishEvent(routingKey, { ...row.payload, _outboxId: row.id });
          await client.query(
            `UPDATE outbox_events SET published = TRUE, published_at = NOW() WHERE id = $1`,
            [row.id]
          );
          logger.debug({ outboxId: row.id, routingKey }, 'outbox event published');
        } catch (publishErr) {
          logger.warn({ outboxId: row.id, err: publishErr.message }, 'outbox publish failed, will retry');
          // Don't mark published; transaction will roll back for this row only
          throw publishErr; // roll back the whole batch — simpler, safe
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code !== 'ECONNREFUSED') {
        logger.warn({ err: err.message }, 'outbox relay cycle error');
      }
    } finally {
      client.release();
    }
  }

  const timer = setInterval(relay, intervalMs);
  relay(); // run immediately on startup
  return timer;
}

module.exports = { insertOutboxEvent, startOutboxRelay };
