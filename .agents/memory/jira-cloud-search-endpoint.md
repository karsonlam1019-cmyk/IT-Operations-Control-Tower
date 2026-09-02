---
name: Jira Cloud search endpoint
description: Durable Jira Cloud requirement to use enhanced JQL search rather than removed legacy routes.
---

Jira Cloud returns HTTP 410 for `/rest/api/3/search` and directs clients to `/rest/api/3/search/jql`.

**Why:** Jira Cloud returns HTTP 410 for the legacy search route and directs clients to the enhanced JQL endpoint.

**How to apply:** For future Jira search work, use the enhanced JQL endpoint unless an explicit compatibility requirement says otherwise.