#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';

const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.config', 'ocean-bedrock', 'bootstrap.json');
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.local', 'state', 'ocean-bedrock', 'ingest-state.json');

function usage() {
  console.log(`Usage:
  npm run ocean:ingest
  npm run ocean:ingest -- --config ~/.config/ocean-bedrock/bootstrap.json --dry-run

Options:
  --config <path>      Bootstrap config path.
  --state <path>       Local ingest state path.
  --source <id>        Only ingest one source id. Can be repeated.
  --dry-run            Scan and report without uploading.
  --all                Override config and allow all extensions.
  --max-files <n>      Stop after n changed files.
  --max-file-mb <n>    Override max file size.
`);
}

function parseArgs(argv) {
  const args = { sources: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--state') args.state = argv[++i];
    else if (arg === '--source') args.sources.push(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--max-files') args.maxFiles = Number(argv[++i]);
    else if (arg === '--max-file-mb') args.maxFileMb = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function remoteJoin(prefix, rel) {
  return `${prefix.replace(/\/$/, '')}/${toPosix(rel).replace(/^\/+/, '')}`;
}

function shouldIgnoreName(name, ignores = []) {
  return ignores.includes(name);
}

function shouldIncludeFile(filePath, config, args) {
  if (args.all || config.feedMode === 'all-files' || config.allowedExtensions === null) return true;
  const ext = path.extname(filePath).toLowerCase();
  return (config.allowedExtensions || []).includes(ext);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function* walk(root, ignores) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = path.join(root, rel);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (shouldIgnoreName(entry.name, ignores)) continue;
      const childRel = path.join(rel, entry.name);
      const childPath = path.join(root, childRel);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) yield { rel: childRel, path: childPath };
    }
  }
}

async function api(config, pathname, options = {}) {
  const response = await fetch(`${config.serverUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.md', '.mdx', '.txt', '.rst', '.log'].includes(ext)) return 'text/plain; charset=utf-8';
  if (['.json', '.jsonl'].includes(ext)) return 'application/json; charset=utf-8';
  if (['.yaml', '.yml'].includes(ext)) return 'application/yaml; charset=utf-8';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return 'text/javascript; charset=utf-8';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const configPath = path.resolve(expandHome(args.config || process.env.OCEAN_BEDROCK_CONFIG || DEFAULT_CONFIG_FILE));
  const statePath = path.resolve(expandHome(args.state || DEFAULT_STATE_FILE));
  const config = await readJson(configPath, null);
  if (!config) throw new Error(`Config not found: ${configPath}. Run npm run ocean:bootstrap first.`);
  if (!config.serverUrl || !config.token) throw new Error('Config is missing serverUrl/token.');

  const state = await readJson(statePath, { version: 1, files: {} });
  const selected = new Set(args.sources);
  const maxFileBytes = Math.max(1, Number(args.maxFileMb || 0)) * 1024 * 1024 || Number(config.maxFileBytes || 10 * 1024 * 1024);
  const maxFiles = args.maxFiles ? Math.max(1, Number(args.maxFiles)) : Infinity;
  const startedAt = new Date().toISOString();

  const manifest = {
    version: 1,
    ownerName: config.ownerName,
    deviceName: config.deviceName,
    serverUrl: config.serverUrl,
    startedAt,
    completedAt: null,
    dryRun: Boolean(args.dryRun),
    sources: [],
    totals: { scanned: 0, skipped: 0, unchanged: 0, changed: 0, uploaded: 0, bytesUploaded: 0, errors: 0 },
  };

  for (const source of config.sources || []) {
    if (!source.enabled) continue;
    if (selected.size && !selected.has(source.id)) continue;
    const root = path.resolve(expandHome(source.localPath));
    const sourceSummary = { id: source.id, label: source.label, localPath: root, remotePrefix: source.remotePrefix, files: [], skipped: 0, unchanged: 0, errors: [] };
    manifest.sources.push(sourceSummary);

    for await (const item of walk(root, config.defaultIgnores || [])) {
      if (manifest.totals.changed >= maxFiles) break;
      manifest.totals.scanned += 1;

      try {
        const stat = await fs.stat(item.path);
        if (stat.size > maxFileBytes || !shouldIncludeFile(item.path, config, args)) {
          manifest.totals.skipped += 1;
          sourceSummary.skipped += 1;
          continue;
        }

        const hash = await sha256File(item.path);
        const stateKey = `${source.id}:${toPosix(item.rel)}`;
        const remotePath = remoteJoin(source.remotePrefix, item.rel);
        const prior = state.files[stateKey];
        if (prior && prior.sha256 === hash && prior.size === stat.size && prior.remotePath === remotePath) {
          manifest.totals.unchanged += 1;
          sourceSummary.unchanged += 1;
          continue;
        }

        manifest.totals.changed += 1;
        const fileRecord = {
          rel: toPosix(item.rel),
          remotePath,
          size: stat.size,
          sha256: hash,
          mtime: stat.mtime.toISOString(),
          uploaded: false,
        };
        sourceSummary.files.push(fileRecord);

        if (!args.dryRun) {
          const bytes = await fs.readFile(item.path);
          await api(config, `/api/v1/file?path=${encodeURIComponent(remotePath)}`, {
            method: 'PUT',
            headers: { 'content-type': contentTypeFor(item.path) },
            body: bytes,
          });
          fileRecord.uploaded = true;
          manifest.totals.uploaded += 1;
          manifest.totals.bytesUploaded += stat.size;
          state.files[stateKey] = {
            sha256: hash,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            remotePath,
            uploadedAt: new Date().toISOString(),
          };
        }
      } catch (error) {
        manifest.totals.errors += 1;
        sourceSummary.errors.push({ rel: toPosix(item.rel), error: error.message });
      }
    }
  }

  manifest.completedAt = new Date().toISOString();
  const manifestPath = `/context/ocean-bedrock/manifests/${config.ownerSlug || 'coworker'}-${config.deviceSlug || 'device'}-${Date.now()}.json`;

  if (!args.dryRun) {
    await api(config, '/api/v1/mkdir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/context/ocean-bedrock/manifests' }),
    });
    await api(config, `/api/v1/file?path=${encodeURIComponent(manifestPath)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    try {
      await api(config, '/api/v1/ledger/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_type: 'ingest.local_folder_synced',
          correlation_id: `cor-ingest-${config.ownerSlug || 'coworker'}-${config.deviceSlug || 'device'}`,
          lab: 'ocean-context',
          virtual_path: manifestPath,
          payload: {
            ownerName: config.ownerName,
            deviceName: config.deviceName,
            manifestPath,
            totals: manifest.totals,
            sources: manifest.sources.map((source) => ({ id: source.id, label: source.label, remotePrefix: source.remotePrefix })),
          },
          clearance: 'CONFIDENTIAL',
          tags: ['ocean-bedrock', 'ingest', 'local-folder-feed'],
        }),
      });
    } catch (error) {
      console.warn(`Ledger event skipped: ${error.message}`);
    }
    state.lastRunAt = manifest.completedAt;
    state.lastManifestPath = manifestPath;
    await writeJson(statePath, state);
  }

  console.log(JSON.stringify({ ok: true, dryRun: Boolean(args.dryRun), configPath, statePath, manifestPath: args.dryRun ? null : manifestPath, totals: manifest.totals, sources: manifest.sources }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
