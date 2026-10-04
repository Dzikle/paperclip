import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "entity-picker-layout.spec.ts",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/picker-layout",
  use: {
    baseURL: "http://127.0.0.1:6107",
    browserName: "chromium",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm --filter @paperclipai/ui exec storybook dev --config-dir storybook/.storybook --host 127.0.0.1 --port 6107 --ci --no-open --disable-telemetry",
    url: "http://127.0.0.1:6107/index.json",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
