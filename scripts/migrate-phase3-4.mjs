#!/usr/bin/env node

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(`
      ALTER TABLE terms ADD COLUMN IF NOT EXISTS related_terms TEXT[] DEFAULT '{}';
      ALTER TABLE terms ADD COLUMN IF NOT EXISTS examples TEXT[] DEFAULT '{}';
      ALTER TABLE terms ADD COLUMN IF NOT EXISTS source_url TEXT;
    `);
    console.log('Migration complete: related_terms, examples, source_url');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
