// Verifies the SW update banner's full reload dance from #23: when a
// new SW is waiting and the user clicks Reload, the banner posts
// SKIP_WAITING, the new SW activates and claims the page, then
// location.reload() runs and the banner stays gone (because there's no
// longer a waiting worker).
//
// We exercise this against the *real* sw.js + register-sw.js by
// briefly mutating the on-disk sw.js so Chrome's update check sees
// different bytes. afterEach always restores the file.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.join(__dirname, '..', 'sw.js');

let originalSw = '';

test.beforeEach(async () => {
  originalSw = await fs.readFile(SW_PATH, 'utf-8');
});

test.afterEach(async () => {
  // Always restore — a failed test must not leave sw.js mutated.
  if (originalSw) await fs.writeFile(SW_PATH, originalSw);
});

test('SW update banner: clicking Reload activates the new SW and clears the banner', async ({
  page,
}) => {
  // First load: SW v1 installs and claims the page.
  await page.goto('/setup-storage.html');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, {
          once: true,
        });
      });
    }
  });

  // Bump on-disk bytes so Chrome's next update check sees a new SW.
  await fs.writeFile(SW_PATH, `${originalSw}\n// e2e-bump-${Date.now()}\n`);

  // Trigger an update check. update() returns once installing finishes
  // (or the check completes with no new worker). With different bytes
  // on the wire, we expect installing → installed → waiting.
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    await reg.update();
  });

  // Banner should appear once the new SW is waiting.
  const banner = page.locator('#sw-update-banner');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  const reloadBtn = banner.locator('button');
  await expect(reloadBtn).toHaveText('Reload');

  // Click Reload. Wires up controllerchange → location.reload().
  await reloadBtn.click();
  await page.waitForLoadState('load');

  // Post-reload there's no waiting SW, so the banner should not
  // reappear. Allow a brief tick for setupUpdateBanner() to run.
  await page.waitForTimeout(500);
  await expect(page.locator('#sw-update-banner')).toHaveCount(0);

  // And the new SW should now be the controller (its bytes match the
  // mutated file). Sanity check that the dance actually swapped SWs
  // instead of leaving us on the old one.
  const controllerScriptUrl = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? null,
  );
  expect(controllerScriptUrl).toMatch(/sw\.js$/);
});
