// E2E for the PWA manifest + install affordance. Validates the
// manifest's required fields and the icon resource resolves; checks
// every page has the (initially-hidden) Install button.
//
// We don't try to fire beforeinstallprompt under Playwright — Chromium
// gates it behind engagement heuristics that don't reliably trigger
// in headless. The integrated behavior is verified manually at deploy
// time on real Chrome on Android.

import { test, expect } from '@playwright/test';

test('manifest has the required PWA fields and a valid icon entry', async ({
  page,
}) => {
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  const m = await res.json();

  expect(m.name).toBeTruthy();
  expect(m.short_name).toBeTruthy();
  expect(m.start_url).toBeTruthy();
  expect(m.display).toBe('standalone');
  expect(m.theme_color).toBeTruthy();
  expect(m.background_color).toBeTruthy();

  expect(Array.isArray(m.icons)).toBe(true);
  expect(m.icons.length).toBeGreaterThan(0);
  const icon = m.icons[0];
  expect(icon.src).toBeTruthy();
  expect(icon.sizes).toBeTruthy();
  expect(icon.purpose).toMatch(/maskable/);

  // Icon resource resolves.
  const iconRes = await page.request.get(
    new URL(icon.src, res.url()).href,
  );
  expect(iconRes.status()).toBe(200);
});

test('every page has a hidden Install button in the navbar', async ({
  page,
}) => {
  for (const path of ['/', '/setup-storage.html', '/setup-folders.html']) {
    await page.goto(path);
    const btn = page.locator('#install-btn');
    await expect(btn).toHaveCount(1);
    // Hidden until beforeinstallprompt fires.
    await expect(btn).toBeHidden();
  }
});
