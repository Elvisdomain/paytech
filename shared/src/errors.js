'use strict';

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.code       = code;
  }
}

class NotFoundError extends AppError {
  constructor(resource, id) {
    super(`${resource} not found: ${id}`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

/**
 * Express error-handling middleware.
 * Mount as the last middleware: app.use(errorHandler(logger))
 */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = err.statusCode || 500;
    const code   = err.code       || 'INTERNAL_ERROR';

    if (status >= 500) {
      logger.error({ err, req: { method: req.method, url: req.url } }, err.message);
    } else {
      logger.warn({ code, message: err.message, url: req.url });
    }

    res.status(status).json({
      error: {
        code,
        message: err.message,
        ...(process.env.NODE_ENV !== 'production' && status >= 500
          ? { stack: err.stack }
          : {}),
      },
    });
  };
}

module.exports = { AppError, NotFoundError, ValidationError, ConflictError, errorHandler };
