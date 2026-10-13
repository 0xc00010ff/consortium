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
    // Tests never call real models: mock mode is forced, every key from the
    // shell is cleared, and the settings file is read from an empty folder
    // instead of the real home folder.
    env: {
      CONSORTIUM_MOCK: "1",
      CONSORTIUM_HOME: `${root}.vitest-home`,
      AI_GATEWAY_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GEMINI_API_KEY: "",
      XAI_API_KEY: "",
    },
  },
});
