'use strict';
const { Router } = require('express');
const { query, NotFoundError, ValidationError } = require('@paytech/shared');

module.exports = function userRoutes(logger) {
  const router = Router();

  // GET /users/:id
  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;

      // Basic UUID format guard — prevents SQL injection via malformed IDs
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ValidationError('Invalid user id format');
      }

      const result = await query(
        `SELECT id, email, name, status, created_at, updated_at
           FROM users
          WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new NotFoundError('User', id);
      }

      const user = result.rows[0];
      logger.info({ userId: user.id }, 'user fetched');
      res.json({ data: user });
    } catch (err) {
      next(err);
    }
  });

  // GET /users  (list — useful for demos / admin)
  router.get('/', async (req, res, next) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
      const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

      const result = await query(
        `SELECT id, email, name, status, created_at
           FROM users
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      res.json({ data: result.rows, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  // POST /users  (create — needed for integration tests / seeding)
  router.post('/', async (req, res, next) => {
    try {
      const { email, name } = req.body || {};

      if (!email || !name) {
        throw new ValidationError('email and name are required');
      }
      if (typeof email !== 'string' || !email.includes('@')) {
        throw new ValidationError('Invalid email address');
      }

      const result = await query(
        `INSERT INTO users (email, name)
         VALUES ($1, $2)
         RETURNING id, email, name, status, created_at`,
        [email.trim().toLowerCase(), name.trim()]
      );

      const user = result.rows[0];
      logger.info({ userId: user.id }, 'user created');
      res.status(201).json({ data: user });
    } catch (err) {
      // Unique email violation
      if (err.code === '23505') {
        return next(Object.assign(new Error('Email already in use'), { statusCode: 409, code: 'CONFLICT' }));
      }
      next(err);
    }
  });

  return router;
};
