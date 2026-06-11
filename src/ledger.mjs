import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const queues = new Map();
const pools = new Map();
let PgPool = null;

const VALID_CLEARANCES = new Set(['PUBLIC', 'UNCLASSIFIED', 'CONFIDENTIAL', 'SECRET', 'TOP_SECRET']);
const VALID_ACTOR_TYPES = new Set(['user', 'agent', 'system', 'service', 'adapter']);

function nowIso() {
  return new Date().toISOString();
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function eventId() {
  return `evt_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function asNumber(value) {
  if (value === null || value === undefined) return value;
  return Number(value);
}

function limitFrom(value, fallback = 100) {
  return Math.max(1, Math.min(Number(value || fallback), 5000));
}

function computeEventHash(eventWithoutHash) {
  return sha256(stableStringify(eventWithoutHash));
}

function normalizeLedgerEvent(input, previous) {
  if (!input || typeof input !== 'object') throw new Error('Ledger event body must be an object.');
  if (!input.event_type && !input.eventType) throw new Error('Ledger event requires event_type.');

  const timestamp = new Date(input.timestamp || input.event_timestamp || input.occurred_at || nowIso()).toISOString();
  const clearance = input.clearance || 'UNCLASSIFIED';
  if (!VALID_CLEARANCES.has(clearance)) {
    throw new Error(`Invalid clearance "${clearance}". Use one of: ${[...VALID_CLEARANCES].join(', ')}`);
  }

  const actorType = input.actor_type || input.actorType || 'system';
  if (!VALID_ACTOR_TYPES.has(actorType)) {
    throw new Error(`Invalid actor_type "${actorType}". Use one of: ${[...VALID_ACTOR_TYPES].join(', ')}`);
  }

  const event = {
    id: input.id || eventId(),
    schema_version: Number(input.schema_version || input.schemaVersion || 1),
    sequence: previous ? Number(previous.sequence) + 1 : 1,
    event_type: input.event_type || input.eventType,
    correlation_id: input.correlation_id || input.correlationId || input.payload?.correlation_id || null,
    lab: input.lab || input.domain || 'longhouse',
    actor_type: actorType,
    actor_id: input.actor_id || input.actorId || null,
    actor_name: input.actor_name || input.actorName || null,
    source_id: input.source_id || input.sourceId || 'longhouse',
    source_sequence: input.source_sequence || input.sourceSequence || null,
    source_ref: input.source_ref || input.sourceRef || null,
    virtual_path: input.virtual_path || input.virtualPath || input.path || null,
    object_id: input.object_id || input.objectId || null,
    payload: input.payload || {},
    visible_context: input.visible_context || input.visibleContext || null,
    context_snapshot: input.context_snapshot || input.contextSnapshot || null,
    clearance,
    tags: Array.isArray(input.tags) ? input.tags : [],
    timestamp,
    received_at: new Date(input.received_at || input.receivedAt || nowIso()).toISOString(),
    prev_hash: previous ? previous.hash : null,
  };

  return { ...event, hash: computeEventHash(event) };
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    schema_version: Number(row.schema_version || 1),
    sequence: asNumber(row.sequence),
    event_type: row.event_type,
    correlation_id: row.correlation_id,
    lab: row.lab,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    actor_name: row.actor_name,
    source_id: row.source_id,
    source_sequence: row.source_sequence,
    source_ref: row.source_ref,
    virtual_path: row.virtual_path,
    object_id: row.object_id,
    payload: row.payload || {},
    visible_context: row.visible_context || null,
    context_snapshot: row.context_snapshot || null,
    clearance: row.clearance,
    tags: row.tags || [],
    timestamp: row.event_timestamp instanceof Date ? row.event_timestamp.toISOString() : row.event_timestamp,
    received_at: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
    prev_hash: row.prev_hash,
    hash: row.hash,
  };
}

async function ensureLedgerFile(ledgerFile) {
  await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
  try {
    await fs.access(ledgerFile);
  } catch {
    await fs.writeFile(ledgerFile, '', { mode: 0o600 });
  }
}

async function readJsonlEvents(ledgerFile) {
  await ensureLedgerFile(ledgerFile);
  const raw = await fs.readFile(ledgerFile, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function appendJsonlLocked(ledgerFile, input) {
  const events = await readJsonlEvents(ledgerFile);
  const previous = events.length ? events[events.length - 1] : null;
  const event = normalizeLedgerEvent(input, previous);
  await fs.appendFile(ledgerFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}

function enqueue(ledgerFile, fn) {
  const previous = queues.get(ledgerFile) || Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(ledgerFile, next.finally(() => {
    if (queues.get(ledgerFile) === next) queues.delete(ledgerFile);
  }));
  return next;
}

function filterEvents(events, filters = {}) {
  return events.filter((event) => {
    if (filters.correlation_id && event.correlation_id !== filters.correlation_id) return false;
    if (filters.actor_id && event.actor_id !== filters.actor_id) return false;
    if (filters.actor_name && event.actor_name !== filters.actor_name) return false;
    if (filters.actor_type && event.actor_type !== filters.actor_type) return false;
    if (filters.event_type && event.event_type !== filters.event_type) return false;
    if (filters.source_id && event.source_id !== filters.source_id) return false;
    if (filters.virtual_path && event.virtual_path !== filters.virtual_path) return false;
    if (filters.path && event.virtual_path !== filters.path) return false;
    return true;
  });
}

async function verifyEvents(events) {
  let previous = null;
  const errors = [];

  for (const event of events) {
    const { hash, ...withoutHash } = event;
    const expectedHash = computeEventHash(withoutHash);
    const expectedSequence = previous ? Number(previous.sequence) + 1 : 1;
    const expectedPrevHash = previous ? previous.hash : null;

    if (Number(event.sequence) !== expectedSequence) {
      errors.push({ id: event.id, sequence: event.sequence, error: `Expected sequence ${expectedSequence}.` });
    }
    if (event.prev_hash !== expectedPrevHash) {
      errors.push({ id: event.id, sequence: event.sequence, error: 'prev_hash does not match previous event hash.' });
    }
    if (hash !== expectedHash) {
      errors.push({ id: event.id, sequence: event.sequence, error: 'hash does not match canonical event body.' });
    }
    previous = event;
  }

  return {
    ok: errors.length === 0,
    events: events.length,
    head: previous ? { sequence: previous.sequence, id: previous.id, hash: previous.hash } : null,
    errors,
  };
}

function createJsonlLedgerStore({ ledgerFile }) {
  if (!ledgerFile) throw new Error('JSONL ledger store requires ledgerFile.');
  return {
    kind: 'jsonl',
    ledgerFile,
    append(input) {
      return enqueue(ledgerFile, () => appendJsonlLocked(ledgerFile, input));
    },
    async read(filters = {}) {
      const events = await readJsonlEvents(ledgerFile);
      const filtered = filterEvents(events, filters);
      return filtered.slice(-limitFrom(filters.limit));
    },
    trace(correlationId, limit = 1000) {
      if (!correlationId) throw new Error('Missing correlation_id.');
      return this.read({ correlation_id: correlationId, limit });
    },
    async verify() {
      return verifyEvents(await readJsonlEvents(ledgerFile));
    },
  };
}

async function getPool(databaseUrl) {
  if (!databaseUrl) throw new Error('Postgres ledger store requires DATABASE_URL.');
  if (!PgPool) ({ Pool: PgPool } = await import('pg'));
  if (!pools.has(databaseUrl)) {
    pools.set(databaseUrl, new PgPool({ connectionString: databaseUrl }));
  }
  return pools.get(databaseUrl);
}

const EVENT_COLUMNS = `
  id,
  schema_version,
  sequence,
  event_type,
  correlation_id,
  lab,
  actor_type,
  actor_id,
  actor_name,
  source_id,
  source_sequence,
  source_ref,
  virtual_path,
  object_id,
  payload,
  visible_context,
  context_snapshot,
  clearance,
  tags,
  event_timestamp,
  received_at,
  prev_hash,
  hash
`;

async function appendPostgresEvent(databaseUrl, input) {
  const pool = await getPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [705031, 1]);

    const sourceId = input.source_id || input.sourceId || 'longhouse';
    const sourceSequence = input.source_sequence || input.sourceSequence || null;
    if (sourceSequence) {
      const existing = await client.query(
        `SELECT ${EVENT_COLUMNS} FROM longhouse.ledger_events WHERE source_id = $1 AND source_sequence = $2 LIMIT 1`,
        [sourceId, sourceSequence],
      );
      if (existing.rows.length) {
        await client.query('COMMIT');
        return rowToEvent(existing.rows[0]);
      }
    }

    const last = await client.query(
      `SELECT id, sequence, hash FROM longhouse.ledger_events ORDER BY sequence DESC LIMIT 1`,
    );
    const previous = last.rows.length ? rowToEvent(last.rows[0]) : null;
    const event = normalizeLedgerEvent(input, previous);

    await client.query(
      `INSERT INTO longhouse.ledger_events (
        id,
        schema_version,
        sequence,
        event_type,
        correlation_id,
        lab,
        actor_type,
        actor_id,
        actor_name,
        source_id,
        source_sequence,
        source_ref,
        virtual_path,
        object_id,
        payload,
        visible_context,
        context_snapshot,
        clearance,
        tags,
        event_timestamp,
        received_at,
        prev_hash,
        hash,
        inserted_by,
        adapter_version
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, $25
      )`,
      [
        event.id,
        event.schema_version,
        event.sequence,
        event.event_type,
        event.correlation_id,
        event.lab,
        event.actor_type,
        event.actor_id,
        event.actor_name,
        event.source_id,
        event.source_sequence,
        event.source_ref,
        event.virtual_path,
        event.object_id,
        event.payload,
        event.visible_context,
        event.context_snapshot,
        event.clearance,
        event.tags,
        event.timestamp,
        event.received_at,
        event.prev_hash,
        event.hash,
        input.inserted_by || input.insertedBy || null,
        input.adapter_version || input.adapterVersion || null,
      ],
    );

    await client.query('COMMIT');
    return event;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
  }
}

async function readPostgresEvents(databaseUrl, filters = {}) {
  const pool = await getPool(databaseUrl);
  const values = [];
  const clauses = [];

  function eq(column, value) {
    if (value === undefined || value === null || value === '') return;
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  }

  eq('correlation_id', filters.correlation_id);
  eq('actor_id', filters.actor_id);
  eq('actor_name', filters.actor_name);
  eq('actor_type', filters.actor_type);
  eq('event_type', filters.event_type);
  eq('source_id', filters.source_id);
  eq('virtual_path', filters.virtual_path || filters.path);

  values.push(limitFrom(filters.limit));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT ${EVENT_COLUMNS}
     FROM longhouse.ledger_events
     ${where}
     ORDER BY sequence DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows.reverse().map(rowToEvent);
}

async function verifyPostgresLedger(databaseUrl) {
  const pool = await getPool(databaseUrl);
  const result = await pool.query(`SELECT ${EVENT_COLUMNS} FROM longhouse.ledger_events ORDER BY sequence ASC`);
  return verifyEvents(result.rows.map(rowToEvent));
}

function createPostgresLedgerStore({ databaseUrl }) {
  if (!databaseUrl) throw new Error('Postgres ledger store requires databaseUrl.');
  return {
    kind: 'postgres',
    append(input) {
      return appendPostgresEvent(databaseUrl, input);
    },
    read(filters = {}) {
      return readPostgresEvents(databaseUrl, filters);
    },
    trace(correlationId, limit = 1000) {
      if (!correlationId) throw new Error('Missing correlation_id.');
      return readPostgresEvents(databaseUrl, { correlation_id: correlationId, limit });
    },
    verify() {
      return verifyPostgresLedger(databaseUrl);
    },
  };
}

export function createLedgerStore(options = {}) {
  const kind = options.store || options.kind || process.env.OCEAN_LEDGER_STORE || (process.env.DATABASE_URL ? 'postgres' : 'jsonl');
  if (kind === 'postgres') {
    return createPostgresLedgerStore({ databaseUrl: options.databaseUrl || process.env.DATABASE_URL });
  }
  if (kind !== 'jsonl') {
    throw new Error(`Unsupported Ocean Ledger store "${kind}". Use jsonl or postgres.`);
  }
  return createJsonlLedgerStore({ ledgerFile: options.ledgerFile });
}

function targetToStore(target) {
  if (target && typeof target === 'object' && typeof target.append === 'function') return target;
  return createJsonlLedgerStore({ ledgerFile: target });
}

export async function appendLedgerEvent(target, input) {
  return targetToStore(target).append(input);
}

export async function readLedgerEvents(target, filters = {}) {
  return targetToStore(target).read(filters);
}

export async function traceLedgerCorrelation(target, correlationId, limit = 1000) {
  return targetToStore(target).trace(correlationId, limit);
}

export async function verifyLedger(target) {
  return targetToStore(target).verify();
}
