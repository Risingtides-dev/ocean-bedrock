# Ocean Bedrock API

Base URL: `http://host:8080`

Auth: `Authorization: Bearer <token>`

All filesystem paths are POSIX-style absolute paths inside the shared root, for example `/docs/brief.md`. `..`, backslashes, and NUL bytes are rejected.

## Roles

| Role | Permissions |
| --- | --- |
| `readonly` | list, stat, read, search |
| `contributor` | read/write/lock under scoped paths; no delete |
| `agent` | read/write/delete/lock under scoped paths |
| `readwrite` | same as `agent` |
| `admin` | all agent permissions plus token and audit management |

Tokens may also have path scopes such as `['/docs', '/context']`.

## Endpoints

### `GET /health`

Public health check.

### `GET /api/v1/info`

Returns instance metadata, default folders, upload limits, and current principal.

### `GET /api/v1/list?path=/docs&depth=1`

Lists a directory. Use `depth > 1` for recursive listing.

### `GET /api/v1/tree?path=/docs&depth=5`

Alias for recursive listing with a higher default depth.

### `GET /api/v1/stat?path=/docs/file.md`

Returns metadata for a file or directory.

### `GET /api/v1/file?path=/docs/file.md[&inline=1]`

Downloads a file. Returns an `ETag` header. Use `inline=1` to avoid attachment content-disposition.

### `PUT /api/v1/file?path=/docs/file.md`

Creates or replaces a file with the raw request body.

Concurrency helpers:

- `If-None-Match: *` prevents overwriting an existing file.
- `If-Match: "etag"` only writes if the current ETag matches.

### `DELETE /api/v1/file?path=/docs/file.md`

Deletes a file.

For directories, pass `recursive=true`:

`DELETE /api/v1/file?path=/docs/old-folder&recursive=true`

### `POST /api/v1/mkdir`

Body:

```json
{ "path": "/docs/projects" }
```

Creates a directory recursively.

### `POST /api/v1/move`

Body:

```json
{ "from": "/docs/a.md", "to": "/docs/archive/a.md", "overwrite": false }
```

Moves/renames a file or directory.

### `POST /api/v1/copy`

Same body as move, but copies recursively.

### `GET /api/v1/search?q=term&path=/docs&limit=50`

Simple text search across scoped files. Large/binary files are skipped.

## Ocean Ledger

Ocean Ledger is append-only context history across files, messages, tickets, sessions, deploys, and other company events.

### `GET /api/v1/ledger/events`

Lists ledger events visible to the token. Optional filters:

```txt
correlation_id
actor_id
actor_name
actor_type
event_type
source_id
path
limit
```

### `POST /api/v1/ledger/events`

Appends an immutable ledger event.

Body:

```json
{
  "event_type": "decision.recorded",
  "correlation_id": "cor-ocean-001",
  "lab": "communications",
  "virtual_path": "/docs/ocean/longhouse.md",
  "payload": { "decision": "Use Cloudflare R2 + Postgres + Vectorize." },
  "clearance": "CONFIDENTIAL",
  "tags": ["architecture", "cloudflare"]
}
```

### `GET /api/v1/ledger/trace?correlation_id=cor-ocean-001`

Returns the visible event chain for a correlation ID.

### `POST /api/v1/ledger/snapshots`

Creates a context snapshot event for what an agent/human could see at a point in time.

Body:

```json
{
  "name": "pre-write-sales-draft",
  "correlation_id": "cor-sales-001",
  "virtual_path": "/sessions/writer/2026-06-08/context.json",
  "files": ["/docs/sales/offer.md", "/context/customer/persona.md"],
  "events": ["evt_abc", "evt_def"],
  "summary": "Context visible before drafting follow-up sequence.",
  "clearance": "CONFIDENTIAL"
}
```

### `GET /api/v1/ledger/verify`

Admin only. Verifies the local hash chain.

## Locks

Locks are lease-based and expire automatically. They are enforced for writes/deletes/moves/copies when a different token owns an intersecting lock.

### `GET /api/v1/locks[?path=/docs/file.md]`

Lists active locks.

### `POST /api/v1/locks`

Body:

```json
{
  "path": "/docs/file.md",
  "ttlSeconds": 900,
  "note": "editing section 2"
}
```

### `DELETE /api/v1/locks/{lockId}`

Releases a lock. Admins can release any lock; agents can release their own locks.

## Tokens

Admin only.

### `GET /api/v1/tokens`

Lists token records without token secrets/hashes.

### `POST /api/v1/tokens`

Body:

```json
{
  "name": "research-agent",
  "role": "agent",
  "scopes": ["/docs", "/context"],
  "ttlDays": 30
}
```

Response includes a `token` field exactly once. Store it immediately.

### `DELETE /api/v1/tokens/{tokenId}`

Revokes a token.

## Audit

### `GET /api/v1/audit?limit=100`

Admin only. Returns recent write/delete/lock/token events.
