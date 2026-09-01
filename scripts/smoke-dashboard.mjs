import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startupTimeoutMs = readPositiveInteger(
  process.env.SMOKE_STARTUP_TIMEOUT_MS,
  30_000,
);
const settleWindowMs = readPositiveInteger(
  process.env.SMOKE_SETTLE_WINDOW_MS,
  1_000,
);
const requestTimeoutMs = 2_000;

function readPositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}"`);
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine an available local port");
  }
  const { port } = address;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

function startService(name, args, environment) {
  const child = spawn("pnpm", args, {
    cwd: rootDir,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const appendOutput = (chunk) => {
    output = `${output}${chunk}`.slice(-20_000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  const exited = new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });

  return { name, child, exited, getOutput: () => output };
}

function assertServiceAlive(service, context) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) {
    const exit = service.child.exitCode ?? service.child.signalCode;
    throw new Error(
      `${service.name} exited ${context} (${exit}).\n${service.getOutput()}`,
    );
  }
}

async function request(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHttp(service, url) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    assertServiceAlive(service, "before becoming ready");
    try {
      const response = await request(url);
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        throw new Error(
          `${service.name} returned HTTP ${response.status} at ${url}: ${body}`,
        );
      }
      return response;
    } catch (error) {
      lastError = error;
      assertServiceAlive(service, "while becoming ready");
      if (error instanceof Error && error.message.includes("returned HTTP")) {
        throw error;
      }
      await delay(250);
    }
  }

  throw new Error(
    `Timed out waiting ${startupTimeoutMs}ms for ${service.name} at ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }\n${service.getOutput()}`,
  );
}

async function stopService(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) {
    await service.exited;
    return;
  }

  const pid = service.child.pid;
  if (pid === undefined) return;

  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }

  const exited = await Promise.race([
    service.exited.then(() => true),
    delay(2_000).then(() => false),
  ]);
  if (!exited) {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await service.exited;
  }
}

async function main() {
  const [apiPort, webPort] = await Promise.all([
    findFreePort(),
    findFreePort(),
  ]);
  const api = startService(
    "API server",
    ["--filter", "@workspace/api-server", "run", "dev"],
    {
      NODE_ENV: "development",
      LOG_LEVEL: "error",
      PORT: String(apiPort),
    },
  );
  const web = startService(
    "IT Operations Control Tower",
    ["--filter", "@workspace/it-operations-control-tower", "run", "dev"],
    {
      NODE_ENV: "development",
      PORT: String(webPort),
      BASE_PATH: "/",
    },
  );

  try {
    const healthResponse = await waitForHttp(
      api,
      `http://127.0.0.1:${apiPort}/api/healthz`,
    );
    const health = await healthResponse.json();
    if (health.status !== "ok") {
      throw new Error(
        `API health check returned an unexpected payload: ${JSON.stringify(health)}`,
      );
    }

    const dashboardResponse = await waitForHttp(
      web,
      `http://127.0.0.1:${webPort}/`,
    );
    const dashboardHtml = await dashboardResponse.text();
    if (
      !dashboardHtml.includes("<title>IT Operations Control Tower</title>") ||
      !dashboardHtml.includes('<div id="root"></div>')
    ) {
      throw new Error(
        "Dashboard root did not serve the IT Operations Control Tower HTML",
      );
    }

    await delay(settleWindowMs);
    assertServiceAlive(api, `after the ${settleWindowMs}ms startup window`);
    assertServiceAlive(web, `after the ${settleWindowMs}ms startup window`);
    console.log(
      `Dashboard smoke check passed: API /api/healthz and dashboard / are healthy on ports ${apiPort}/${webPort}.`,
    );
  } finally {
    await Promise.all([stopService(api), stopService(web)]);
  }
}

main().catch((error) => {
  console.error(
    `Dashboard smoke check failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});