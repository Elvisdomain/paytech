'use strict';
const { Router } = require('express');
const { ValidationError } = require('@paytech/shared');
const { scorePayment } = require('./scorer');

module.exports = function fraudRoutes(logger) {
  const router = Router();

  /**
   * POST /fraud/score
   *
   * Called synchronously by payment-service before charging.
   * Body: { paymentId, userId, amount, currency, metadata? }
   * Response: { score, decision, reasons }
   *
   * This is a synchronous call on the payment critical path.
   * If fraud-service is down, payment-service should:
   *   a) fail the payment (safe, conservative), OR
   *   b) approve with a flag for manual review (revenue-preserving)
   * payment-service implements option (a) by default, configurable via env.
   */
  router.post('/score', (req, res, next) => {
    try {
      const { paymentId, userId, amount, currency } = req.body || {};

      if (!paymentId || !userId || amount == null) {
        throw new ValidationError('paymentId, userId, and amount are required');
      }
      if (typeof amount !== 'number' || amount <= 0) {
        throw new ValidationError('amount must be a positive number');
      }

      const result = scorePayment({ userId, amount, currency: currency || 'USD' });

      logger.info({
        paymentId,
        userId,
        amount,
        score:    result.score,
        decision: result.decision,
      }, 'fraud score computed');

      res.json({ data: { paymentId, ...result } });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
