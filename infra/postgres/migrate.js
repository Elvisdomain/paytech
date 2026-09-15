'use strict';
/**
 * Migration runner — executed as a one-off task in cloud environments.
 *
 * GCP: Cloud Run Job
 * AWS: ECS Fargate one-shot task
 *
 * Reads all *.sql files from the migrations/ directory in sort order
 * and runs them against the configured PostgreSQL instance.
 *
 * All migrations use IF NOT EXISTS / ON CONFLICT DO NOTHING so they are
 * safe to re-run on every deployment without side effects.
 */

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function run() {
  const client = new Client({
    host:     process.env.POSTGRES_HOST,
    port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB       || 'paytech',
    user:     process.env.POSTGRES_USER     || 'paytech',
    password: process.env.POSTGRES_PASSWORD,
    ssl:      process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  console.log(`Connected to ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`Running migration: ${file}`);
    await client.query(sql);
    console.log(`  ✓ ${file}`);
  }

  await client.end();
  console.log('All migrations complete.');
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
