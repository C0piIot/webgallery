// E2E regression test: every page ships a Content-Security-Policy
// meta with the directives we depend on.

import { test, expect } from '@playwright/test';

test('every page ships a CSP meta with the expected directives', async ({
  page,
}) => {
  for (const path of ['/', '/setup-storage.html', '/setup-folders.html']) {
    await page.goto(path);
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(csp, `missing CSP on ${path}`).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'self'");
  }
});
