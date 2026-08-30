import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve("artifacts/it-operations-control-tower/src"),
    },
  },
  test: {
    include: ["artifacts/**/*.test.{ts,tsx}"],
  },
});