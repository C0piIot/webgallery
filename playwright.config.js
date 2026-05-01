import { defineConfig, devices } from '@playwright/test';

// Playwright owns the static server during tests so the page origin is
// localhost (a secure context — required for aws4fetch's crypto.subtle
// HMAC signing). webServer below boots python3's stdlib http.server in
// the test runner's environment; teardown is automatic.

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  webServer: {
    command: 'python3 -m http.server 8080 --bind 127.0.0.1',
    url: 'http://localhost:8080/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
