'use strict';
const { httpClient } = require('@paytech/shared');

const FRAUD_URL = process.env.FRAUD_SERVICE_URL || 'http://fraud-service:3005';

/**
 * Call fraud-service synchronously.
 *
 * Failure modes and how payment-service handles them:
 *
 *   • fraud-service returns 5xx or times out
 *     → httpClient retries up to 3× with exponential back-off.
 *     → If still failing, we check FRAUD_FAIL_OPEN env var:
 *         FRAUD_FAIL_OPEN=true  → approve with score=null, decision='review'
 *                                  (revenue-preserving, riskier)
 *         FRAUD_FAIL_OPEN=false → reject the payment (safe default)
 *
 *   • fraud-service returns decision='rejected'
 *     → payment-service marks payment as failed, no charge happens.
 *
 *   • fraud-service returns decision='review'
 *     → payment-service proceeds but tags the payment for manual review.
 *     → In a real system you'd also pause settlement here.
 */
async function checkFraud({ paymentId, userId, amount, currency }) {
  try {
    const response = await httpClient.request(`${FRAUD_URL}/fraud/score`, {
      method: 'POST',
      body:   { paymentId, userId, amount, currency },
    });

    if (response.status === 200) {
      return response.body.data; // { score, decision, reasons }
    }

    throw Object.assign(
      new Error(`Fraud service returned ${response.status}: ${JSON.stringify(response.body)}`),
      { statusCode: response.status }
    );
  } catch (err) {
    const failOpen = process.env.FRAUD_FAIL_OPEN === 'true';

    if (failOpen) {
      return { score: null, decision: 'review', reasons: ['FRAUD_SERVICE_UNAVAILABLE'] };
    }

    throw Object.assign(
      new Error(`Fraud check failed and FRAUD_FAIL_OPEN=false: ${err.message}`),
      { statusCode: 503, code: 'FRAUD_SERVICE_UNAVAILABLE' }
    );
  }
}

module.exports = { checkFraud };
