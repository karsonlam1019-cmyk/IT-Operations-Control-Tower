export type IntegrationStatus = {
  name: string;
  configured: boolean;
  status: "ok" | "not_configured" | "error";
  latencyMs?: number;
  message?: string;
};

export const INTEGRATION_TIMEOUT_MS = 5_000;

export function readEnv(key: string): string | undefined {
  const value = process.env[key];
  if (!value || value.trim() === "" || value.toUpperCase().includes("PASTE") || value.toUpperCase().includes("YOUR_")) {
    return undefined;
  }
  return value.trim();
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = INTEGRATION_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Provider request timed out";
  }
  return error instanceof Error ? error.message : "Unknown provider error";
}
