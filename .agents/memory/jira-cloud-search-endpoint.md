---
name: Jira Cloud search endpoint
description: Live endpoint behavior observed when running the Jira shift synchronization.
---

Jira Cloud returns HTTP 410 for `/rest/api/3/search` and directs clients to `/rest/api/3/search/jql`.

**Why:** A live synchronization attempt on 2026-08-30 reached Jira successfully but the explicitly requested legacy endpoint had already been removed.

**How to apply:** For future Jira search work, use the enhanced JQL endpoint unless an explicit compatibility requirement says otherwise.