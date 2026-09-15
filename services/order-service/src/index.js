'use strict';
const express = require('express');
const { createLogger, errorHandler, consume } = require('@paytech/shared');
const orderRoutes    = require('./routes');
const { handlePaymentEvent } = require('./paymentConsumer');

const PORT   = process.env.PORT || 3003;
const logger = createLogger('order-service');
const app    = express();

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'order-service' }));
app.use('/orders', orderRoutes(logger));

app.use(errorHandler(logger));

app.listen(PORT, async () => {
  logger.info({ port: PORT }, 'order-service listening');

  // Subscribe to payment events so orders can auto-transition to 'paid'
  // when a linked payment succeeds.
  //
  // This demonstrates the "order-service as downstream consumer" pattern:
  // payment-service doesn't know about orders, it just fires events.
  // order-service reacts to those events independently.
  try {
    await consume('order.payment.events', (msg, content) =>
      handlePaymentEvent(content, logger)
    );
    logger.info('subscribed to order.payment.events queue');
  } catch (err) {
    // Don't crash on startup if RabbitMQ isn't up yet —
    // Docker healthcheck + restart policy handles reconnection.
    logger.warn({ err: err.message }, 'could not connect to RabbitMQ on startup, will retry');
  }
});
