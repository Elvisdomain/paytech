'use strict';
const pino = require('pino');

/**
 * Creates a structured JSON logger.
 * Every service passes its name so log lines always carry a `service` field.
 */
function createLogger(serviceName) {
  return pino({
    name: serviceName,
    level: process.env.LOG_LEVEL || 'info',
    base: { service: serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger };
