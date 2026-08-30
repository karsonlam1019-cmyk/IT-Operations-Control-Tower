---
name: Artifact workflow port ownership
description: Prevent duplicate legacy workflows and orphaned processes from blocking managed artifact services.
---

Managed artifact workflows must be the only workflow definitions that own their assigned API and web preview ports.

**Why:** Legacy `.replit` workflows duplicated the managed artifact services. Removing those definitions did not immediately stop their existing processes, so the managed services continued to fail with `EADDRINUSE` until the stale process trees were stopped.

**How to apply:** Do not add standalone workflows for registered artifacts. If duplicate workflows are removed while running, verify the assigned ports are free before restarting each managed `artifacts/<slug>: <service>` workflow.