import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [".research/**", "node_modules/**", "dist/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
