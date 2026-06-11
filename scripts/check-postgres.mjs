#!/usr/bin/env node
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await pool.query(`
    SELECT
      current_database() AS database,
      current_user AS user,
      to_regclass('longhouse.mounts') AS mounts_table,
      to_regclass('longhouse.ledger_events') AS ledger_events_table,
      to_regclass('longhouse.context_snapshots') AS context_snapshots_table
  `);
  const row = result.rows[0];
  console.log(JSON.stringify({
    ok: true,
    database: row.database,
    user: row.user,
    schemaReady: Boolean(row.mounts_table && row.ledger_events_table && row.context_snapshots_table),
    tables: {
      mounts: row.mounts_table,
      ledgerEvents: row.ledger_events_table,
      contextSnapshots: row.context_snapshots_table,
    },
  }, null, 2));
} finally {
  await pool.end();
}
