'use strict';
const express = require('express');
const { createLogger, errorHandler } = require('@paytech/shared');
const ledgerRoutes = require('./routes');

const PORT   = process.env.PORT || 3006;
const logger = createLogger('ledger-service');
const app    = express();

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'ledger-service' }));
app.use('/ledger', ledgerRoutes(logger));

app.use(errorHandler(logger));

app.listen(PORT, () => logger.info({ port: PORT }, 'ledger-service listening'));
