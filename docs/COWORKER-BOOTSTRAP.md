# Coworker Bootstrap

This is the coworker-facing flow for feeding selected local folders into the Ocean knowledge layer.

You choose exactly which folders are active. The bootstrapper saves a local config, then the ingest command uploads changed files to the shared Bedrock/Longhouse HTTP service using your scoped MCP/Bearer token.

## What you need

- Node.js 22+
- Bedrock/Longhouse URL
- Your MCP/Bearer token
- The folders you want to feed, e.g. `~/Documents/RisingTides`, `~/Projects/ocean-notes`

## Bootstrap

Interactive:

```bash
npm run ocean:bootstrap
```

Non-interactive:

```bash
npm run ocean:bootstrap -- \
  --server https://bedrock.example.com \
  --token '<MCP_TOKEN>' \
  --name alice \
  --folder ~/Documents/RisingTides \
  --folder ~/Projects/ocean-notes \
  --yes
```

This creates:

```txt
~/.config/ocean-bedrock/bootstrap.json
~/.config/ocean-bedrock/env
```

The token is stored locally with file mode `0600`. Do not commit or share this file.

## Ingest selected folders

Dry run first:

```bash
npm run ocean:ingest -- --dry-run
```

Upload changed files:

```bash
npm run ocean:ingest
```

Only changed files are uploaded after the first run. Local state is stored at:

```txt
~/.local/state/ocean-bedrock/ingest-state.json
```

## Default include/skip behavior

By default, ingest includes common knowledge/document/code files:

```txt
.md .txt .json .yaml .csv .html .js .ts .py .rs .go .sql .pdf .docx .pptx .xlsx ...
```

It skips common noisy folders/files:

```txt
.git node_modules .venv target dist build .next .cache __pycache__ .DS_Store
```

Max file size defaults to `10 MB`.

To feed all file types under the max size:

```bash
npm run ocean:bootstrap -- --all-files ...
# or just for one ingest run:
npm run ocean:ingest -- --all
```

## Where your files land

Your files are mapped to:

```txt
/coworkers/<your-name>/<device>/<folder-label>/...
```

A redacted source registration is written to:

```txt
/context/ocean-bedrock/sources/<your-name>-<device>.json
```

Each ingest run writes a manifest to:

```txt
/context/ocean-bedrock/manifests/...
```

## Security notes

- Only choose folders you want shared with the company knowledge layer.
- Do not select password manager exports, SSH key folders, raw credential folders, or private personal directories.
- Your token should be scoped; it should not be an admin token.
- If a token leaks, ask an admin to revoke it and issue a new one.
