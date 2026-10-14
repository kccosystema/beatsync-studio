import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**", "node_modules/**"], testTimeout: 60000 },
});
