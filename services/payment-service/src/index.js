'use strict';
const express = require('express');
const { createLogger, errorHandler, getPool, startOutboxRelay } = require('@paytech/shared');
const paymentRoutes = require('./routes');

const PORT   = process.env.PORT || 3002;
const logger = createLogger('payment-service');
const app    = express();

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'payment-service' }));
app.use('/payments', paymentRoutes(logger));

app.use(errorHandler(logger));

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'payment-service listening');

  // Start the transactional outbox relay in-process.
  // This polls for unpublished outbox rows and publishes them to RabbitMQ.
  // If RabbitMQ is temporarily down, events accumulate in the DB and are
  // published once it recovers — guaranteed delivery without losing events.
  startOutboxRelay(getPool(), logger, 2000);
  logger.info('outbox relay started');
});
