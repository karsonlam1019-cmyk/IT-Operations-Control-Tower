import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createJiraSyncScheduler,
  getJiraSyncIntervalMs,
} from "./jiraSyncScheduler.js";

test("leaves scheduled sync disabled when no interval is configured", () => {
  assert.equal(getJiraSyncIntervalMs({ JIRA_SYNC_INTERVAL_MINUTES: "" }), null);
  assert.equal(getJiraSyncIntervalMs({}), null);
});

test("converts the configured interval from minutes to milliseconds", () => {
  assert.equal(
    getJiraSyncIntervalMs({ JIRA_SYNC_INTERVAL_MINUTES: "5" }),
    300_000,
  );
});

test("rejects invalid or excessively long intervals", () => {
  for (const value of ["0", "-1", "not-a-number", "35792"]) {
    assert.throws(
      () => getJiraSyncIntervalMs({ JIRA_SYNC_INTERVAL_MINUTES: value }),
      /JIRA_SYNC_INTERVAL_MINUTES/,
    );
  }
});

test("runs immediately, continues after failures, and prevents overlap", async () => {
  const timerCallbacks = [];
  const logs = [];
  const warnings = [];
  const errors = [];
  let resolveFirstSync;
  let syncCalls = 0;

  const sync = async () => {
    syncCalls += 1;
    if (syncCalls === 1) {
      return { count: 2 };
    }
    if (syncCalls === 2) {
      await new Promise((resolve) => {
        resolveFirstSync = resolve;
      });
      return { count: 3 };
    }
    throw new Error("Jira unavailable");
  };

  const scheduler = createJiraSyncScheduler({
    intervalMs: 60_000,
    sync,
    setIntervalImpl(callback) {
      timerCallbacks.push(callback);
      return "timer";
    },
    clearIntervalImpl(timer) {
      assert.equal(timer, "timer");
    },
    log: {
      log(message) {
        logs.push(message);
      },
      warn(message) {
        warnings.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
  });

  scheduler.start();
  assert.equal(timerCallbacks.length, 1);
  assert.deepEqual(await scheduler.runSync(), { count: 2 });

  const inProgressRun = timerCallbacks[0]();
  await Promise.resolve();
  const overlappingRun = await scheduler.runSync();
  assert.deepEqual(overlappingRun, { skipped: true });
  assert.equal(warnings.length, 1);

  resolveFirstSync();
  await inProgressRun;

  await timerCallbacks[0]();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Jira unavailable/);
  assert.equal(logs.length, 2);

  scheduler.stop();
});
