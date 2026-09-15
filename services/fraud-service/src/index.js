'use strict';
const express = require('express');
const { createLogger, errorHandler } = require('@paytech/shared');
const fraudRoutes = require('./routes');

const PORT   = process.env.PORT || 3005;
const logger = createLogger('fraud-service');
const app    = express();

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'fraud-service' }));
app.use('/fraud', fraudRoutes(logger));

app.use(errorHandler(logger));

app.listen(PORT, () => logger.info({ port: PORT }, 'fraud-service listening'));
