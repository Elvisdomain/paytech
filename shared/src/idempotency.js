'use strict';
const crypto = require('crypto');
const { withTransaction } = require('./db');

/**
 * Idempotency guard for write endpoints.
 *
 * Usage (inside a route handler):
 *
 *   const result = await withIdempotency({
 *     key:         req.headers['idempotency-key'],
 *     service:     'payment-service',
 *     requestBody: req.body,
 *     handler:     async (client) => { ... return { status, body }; }
 *   });
 *   res.status(result.status).json(result.body);
 *
 * How it works:
 *   1. Hash the request body.
 *   2. Inside a transaction, try to INSERT into idempotency_keys.
 *   3. If the INSERT succeeds → run handler, write response, commit.
 *   4. If the INSERT violates the PK constraint → a prior call exists.
 *      a. If the prior request hash matches → return the cached response (idempotent replay).
 *      b. If hashes differ → 422 (same key, different body = client bug).
 *   5. If handler throws → transaction rolls back, idempotency key row is NOT stored,
 *      so the client can safely retry.
 */
async function withIdempotency({ key, service, requestBody, handler }) {
  if (!key) {
    throw Object.assign(new Error('Idempotency-Key header is required'), { statusCode: 400 });
  }

  if (typeof key !== 'string' || key.length < 8 || key.length > 255) {
    throw Object.assign(
      new Error('Idempotency-Key must be a string between 8 and 255 characters'),
      { statusCode: 400 }
    );
  }

  const requestHash = hashBody(requestBody);

  return withTransaction(async (client) => {
    // Try to claim the idempotency key
    const existing = await client.query(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
        WHERE idempotency_key = $1 AND service = $2`,
      [key, service]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash) {
        // Same key, different body → client sent two different requests with the same key
        throw Object.assign(
          new Error(
            'Idempotency key already used with a different request body. ' +
            'Use a new Idempotency-Key for a new request.'
          ),
          { statusCode: 422 }
        );
      }
      // Idempotent replay: return the cached response without re-executing the handler
      return { status: row.response_status, body: row.response_body, replayed: true };
    }

    // Key not seen before — run the actual handler
    const { status, body } = await handler(client);

    // Persist the response so future replays can return it
    await client.query(
      `INSERT INTO idempotency_keys (idempotency_key, service, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, service, requestHash, status, JSON.stringify(body)]
    );

    return { status, body, replayed: false };
  });
}

function hashBody(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex');
}

module.exports = { withIdempotency, hashBody };
