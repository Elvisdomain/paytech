'use strict';
const express = require('express');
const { createLogger, errorHandler } = require('@paytech/shared');
const userRoutes = require('./routes');

const PORT   = process.env.PORT || 3001;
const logger = createLogger('user-service');
const app    = express();

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'user-service' }));
app.use('/users', userRoutes(logger));

app.use(errorHandler(logger));

app.listen(PORT, () => logger.info({ port: PORT }, 'user-service listening'));
