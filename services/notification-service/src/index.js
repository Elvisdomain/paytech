'use strict';
const express = require('express');
const { createLogger, errorHandler, consume } = require('@paytech/shared');
const { handlePaymentEvent } = require('./paymentConsumer');
const notificationRoutes     = require('./routes');

const PORT   = process.env.PORT || 3004;
const logger = createLogger('notification-service');
const app    = express();

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'notification-service' }));
app.use('/notifications', notificationRoutes(logger));

app.use(errorHandler(logger));

app.listen(PORT, async () => {
  logger.info({ port: PORT }, 'notification-service listening');

  try {
    await consume('notification.payment.events', (msg, content) =>
      handlePaymentEvent(content, logger)
    );
    logger.info('subscribed to notification.payment.events queue');
  } catch (err) {
    logger.warn({ err: err.message }, 'could not connect to RabbitMQ on startup, will retry');
  }
});
