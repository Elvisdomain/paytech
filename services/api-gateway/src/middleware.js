'use strict';
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

// ── Request logger ────────────────────────────────────────────────────────────
function requestLogger(logger) {
  return (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-Id', req.requestId);

    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        requestId: req.requestId,
        method:    req.method,
        url:       req.originalUrl,
        status:    res.statusCode,
        ms:        Date.now() - start,
      });
    });
    next();
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// In production: verify JWT against an identity provider.
// Here: static API key list loaded from env so the demo is runnable without
// a full IdP. The key is forwarded downstream as X-Authenticated-User-Id
// so services don't need to re-authenticate.
const VALID_KEYS = new Set(
  (process.env.VALID_API_KEYS || 'test-key-alice,test-key-bob').split(',').map(k => k.trim())
);

// Map of key → user_id (demo only)
const KEY_TO_USER = {
  'test-key-alice': '00000000-0000-0000-0000-000000000001',
  'test-key-bob':   '00000000-0000-0000-0000-000000000002',
};

function authMiddleware(logger) {
  return (req, res, next) => {
    const key = req.headers['x-api-key'];

    if (!key || !VALID_KEYS.has(key)) {
      logger.warn({ url: req.originalUrl, key: key ? '[redacted]' : 'missing' }, 'auth failed');
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' } });
    }

    // Inject identity so downstream services trust it without re-authing
    req.headers['x-authenticated-user-id'] = KEY_TO_USER[key] || 'unknown';
    req.headers['x-request-id']            = req.requestId;
    next();
  };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimiter = rateLimit({
  windowMs: 60_000,       // 1 minute
  max:      200,          // 200 req/min per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' } },
});

module.exports = { requestLogger, authMiddleware, rateLimiter };
