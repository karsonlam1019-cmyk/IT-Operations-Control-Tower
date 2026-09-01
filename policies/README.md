# Policy PDF drop zone

Place the source IT policy PDFs in this directory. The initial three policy
documents are copied here from `docs/`; the originals remain preserved there.
Only files ending in `.pdf` are read by the ingestion command, in deterministic
filename order. Other files are ignored.

## Validate locally

From the repository root, add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`COHERE_API_KEY` as Replit Secrets (or export them in the shell), then run:

```sh
node ingest.js --dry-run
```

Dry-run validates the configuration and reports every PDF's page count,
extracted text size, chunk count, and the configured 1024-dimensional embedding
width. It does not call Cohere or change Supabase.

Run the explicit indexing command only after reviewing the dry-run:

```sh
node ingest.js
```

The command uses 500-token chunks with 50-token overlap, preserves page and
section metadata, and replaces existing vectors for each source filename so
re-running it is safe. Scanned/image-only PDFs are not supported.
