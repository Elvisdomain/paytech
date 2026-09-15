'use strict';
const { httpClient } = require('@paytech/shared');

const LEDGER_URL = process.env.LEDGER_SERVICE_URL || 'http://ledger-service:3006';

/**
 * Post a double-entry to the ledger service.
 *
 * We pass the payment's idempotency key so ledger-service can safely
 * deduplicate if payment-service retries after a partial failure.
 *
 * Failure mode:
 *   If ledger-service is down, the payment has already been marked
 *   'succeeded' in our DB (we do that first, inside the idempotency
 *   transaction). The outbox event will still fire so downstream
 *   consumers know the payment succeeded. The ledger entry can be
 *   backfilled from the outbox event later.
 *
 *   This is a deliberate trade-off: we prefer eventual consistency in
 *   the ledger over failing the customer's payment.
 */
async function recordLedgerEntry({ idempotencyKey, paymentId, userId, amount, currency, type }) {
  const response = await httpClient.request(`${LEDGER_URL}/ledger/entries`, {
    method: 'POST',
    body:   { idempotencyKey, paymentId, userId, amount, currency, type },
  });

  if (response.status === 200 || response.status === 201) {
    return response.body.data;
  }

  throw Object.assign(
    new Error(`Ledger service returned ${response.status}: ${JSON.stringify(response.body)}`),
    { statusCode: response.status }
  );
}

module.exports = { recordLedgerEntry };
