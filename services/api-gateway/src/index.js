'use strict';
const express    = require('express');
const { createLogger } = require('@paytech/shared');
const { createProxies }  = require('./proxy');
const { requestLogger, authMiddleware, rateLimiter } = require('./middleware');
const { errorHandler } = require('@paytech/shared');

const PORT   = process.env.PORT || 3000;
const logger = createLogger('api-gateway');
const app    = express();

app.use(express.json());
app.use(requestLogger(logger));
app.use(rateLimiter);

// Health — no auth required
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

// All /api/* routes require a valid API key
app.use('/api', authMiddleware(logger));

// Mount reverse-proxy routes
createProxies(app, logger);

app.use(errorHandler(logger));

app.listen(PORT, () => logger.info({ port: PORT }, 'api-gateway listening'));
