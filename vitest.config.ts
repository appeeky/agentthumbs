import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/agentthumbs/test/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
