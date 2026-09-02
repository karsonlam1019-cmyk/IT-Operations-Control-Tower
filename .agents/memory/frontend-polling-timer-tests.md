---
name: Frontend polling timer tests
description: Testing page-specific timers when React Query also schedules refetch polling.
---

When a page owns a timer in addition to React Query polling, test spies should filter timer registrations by the intended delay rather than assuming the page creates the only interval.

**Why:** React Query may register its own polling interval during the same render, so a broad setInterval assertion can fail while the page timer is correct.

**How to apply:** Capture only callbacks registered with the feature’s interval, and separately verify the feature callback runs after the expected schedule.