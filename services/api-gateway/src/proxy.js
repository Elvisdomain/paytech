'use strict';
const { createProxyMiddleware } = require('http-proxy-middleware');

/**
 * Service registry.
 * In production this would be service-discovery (Consul, k8s DNS, etc.).
 * Here we read from env with sensible docker-compose defaults.
 */
const SERVICES = {
  users:         process.env.USER_SERVICE_URL         || 'http://user-service:3001',
  payments:      process.env.PAYMENT_SERVICE_URL      || 'http://payment-service:3002',
  orders:        process.env.ORDER_SERVICE_URL        || 'http://order-service:3003',
  notifications: process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3004',
};

function createProxies(app, logger) {
  // Helper that produces a proxy middleware with consistent options
  function proxy(target, pathRewrite) {
    return createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite,
      on: {
        error: (err, req, res) => {
          logger.error({ target, err: err.message, url: req.originalUrl }, 'proxy error');
          if (!res.headersSent) {
            res.status(502).json({
              error: {
                code:    'BAD_GATEWAY',
                message: `Upstream service unavailable: ${err.message}`,
              },
            });
          }
        },
        proxyReq: (proxyReq, req) => {
          // Propagate tracing / auth headers
          ['x-request-id', 'x-authenticated-user-id', 'idempotency-key'].forEach((h) => {
            if (req.headers[h]) proxyReq.setHeader(h, req.headers[h]);
          });
        },
      },
    });
  }

  // ── Route table ──────────────────────────────────────────────────────────────
  // /api/users/**      → user-service
  app.use('/api/users', proxy(SERVICES.users, { '^/api/users': '/users' }));

  // /api/payments/**   → payment-service
  app.use('/api/payments', proxy(SERVICES.payments, { '^/api/payments': '/payments' }));

  // /api/orders/**     → order-service
  app.use('/api/orders', proxy(SERVICES.orders, { '^/api/orders': '/orders' }));

  // /api/notifications/** → notification-service (admin / read-only)
  app.use('/api/notifications', proxy(SERVICES.notifications, { '^/api/notifications': '/notifications' }));

  logger.info({ routes: Object.keys(SERVICES) }, 'proxy routes registered');
}

module.exports = { createProxies, SERVICES };
