---
name: Supabase policy vector contract
description: The live Supabase policy vector dimension differs from the original schema draft.
---

The live `knowledge_base_vectors.embedding` column is `vector(1024)`, so policy ingestion must request 1024-dimensional Cohere embeddings and the vector-search RPC signature must use the same width.

**Why:** The repository’s original policy schema draft specified 1536 dimensions, but the restored live Supabase table uses 1024; ingestion can spend time generating embeddings and then fail on the first database write if these contracts drift.

**How to apply:** Treat the live database vector width as the integration contract when changing policy ingestion or search. Preserve structured Supabase error details when diagnosing write failures.