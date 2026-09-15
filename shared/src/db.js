'use strict';
const { Pool } = require('pg');

let pool;

/**
 * Returns a singleton pg.Pool connected to the shared PostgreSQL instance.
 * All services share one database but use separate schemas / tables.
 */
function getPool() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.POSTGRES_HOST     || 'localhost',
      port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB       || 'paytech',
      user:     process.env.POSTGRES_USER     || 'paytech',
      password: process.env.POSTGRES_PASSWORD || 'paytech',
      max:      parseInt(process.env.PG_POOL_MAX || '10', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err) => {
      console.error('pg pool error', err);
    });
  }
  return pool;
}

/**
 * Convenience wrapper: run a query with automatic error context.
 */
async function query(sql, params) {
  const pool = getPool();
  return pool.query(sql, params);
}

/**
 * Run fn(client) inside a serializable transaction.
 * Rolls back automatically on any thrown error.
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction };
