import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  use: {
    // Inside docker, PLAYWRIGHT_BASE_URL is set to http://static:8080.
    // For host-side runs, default to the host port mapped in compose.
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8888',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
