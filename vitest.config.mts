import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: root }],
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    // Tests never call real models: mock mode is forced, and any key from the
    // shell is cleared.
    env: { CONSORTIUM_MOCK: "1", AI_GATEWAY_API_KEY: "" },
  },
});
