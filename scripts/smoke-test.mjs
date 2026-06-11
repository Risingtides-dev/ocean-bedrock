#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createOceanBedrockServer } from '../src/server.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocean-bedrock-smoke-'));
process.env.OCEAN_BEDROCK_BOOTSTRAP_TOKEN = 'smoke-admin-token';
process.env.OCEAN_LEDGER_STORE = 'jsonl';

const { server, ready } = createOceanBedrockServer({ root, instance: 'smoke-test' });
await ready;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const token = 'smoke-admin-token';

async function api(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return { response, body };
}

try {
  await api('/api/v1/info');
  await api('/api/v1/mkdir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/docs/smoke' }),
  });
  await api('/api/v1/file?path=/docs/smoke/hello.md', {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown' },
    body: '# hello\n\nshared filesystem works\n',
  });
  const readBack = await api('/api/v1/file?path=/docs/smoke/hello.md&inline=1');
  if (!String(readBack.body).includes('shared filesystem works')) throw new Error('readback did not match');
  const lock = await api('/api/v1/locks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/docs/smoke/hello.md', note: 'smoke test' }),
  });
  await api(`/api/v1/locks/${lock.body.id}`, { method: 'DELETE' });
  await api('/api/v1/ledger/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_type: 'decision.recorded',
      correlation_id: 'cor-smoke-001',
      lab: 'smoke',
      virtual_path: '/docs/smoke/hello.md',
      payload: { decision: 'Smoke test ledger event' },
      clearance: 'UNCLASSIFIED',
    }),
  });
  await api('/api/v1/ledger/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'smoke-context',
      correlation_id: 'cor-smoke-001',
      virtual_path: '/docs/smoke/hello.md',
      files: ['/docs/smoke/hello.md'],
      events: [],
      summary: 'Smoke test context snapshot',
      clearance: 'CONFIDENTIAL',
    }),
  });
  const trace = await api('/api/v1/ledger/trace?correlation_id=cor-smoke-001');
  if (trace.body.events.length < 2) throw new Error('ledger trace returned too few events');
  const verify = await api('/api/v1/ledger/verify');
  if (!verify.body.ok) throw new Error(`ledger verify failed: ${JSON.stringify(verify.body.errors)}`);
  const search = await api('/api/v1/search?q=shared&path=/docs');
  if (!search.body.results.length) throw new Error('search returned no results');
  await api('/api/v1/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-agent', role: 'agent', scopes: ['/docs'], ttlDays: 1 }),
  });
  console.log('ocean-bedrock smoke test passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
