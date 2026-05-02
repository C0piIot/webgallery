// ESLint flat config. Keep the rule set small — recommended preset
// catches the bugs that bite (no-undef, no-unused-vars, no-unreachable,
// no-dupe-keys), and we don't enforce stylistic rules.
//
// Per-file env overrides because this codebase has four contexts:
// browser pages, the Service Worker (sw.js), the sync Web Worker
// (lib/sync-worker.js), and Node-side test runners.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'vendor/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'coverage/**',
    ],
  },

  // Default: browser globals for page modules + lib/.
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Allow `_`-prefixed unused args (common pattern for ignored
      // event/callback parameters) and unused destructured siblings.
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Empty catches are intentional in a few best-effort spots
      // (`try { abortMultipartUpload } catch {}`). Allow them.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Service Worker: separate global set (no window/document; has
  // self/caches/clients).
  {
    files: ['sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },

  // Web Worker (the sync engine).
  {
    files: ['lib/sync-worker.js'],
    languageOptions: {
      globals: { ...globals.worker },
    },
  },

  // Tests + e2e + config: Node + browser globals (e2e fixtures use
  // Node's Buffer + dynamic imports; page.evaluate code runs as
  // browser code referenced as text — globals matter for either side
  // since the linter sees one file).
  {
    files: ['tests/**/*.js', 'e2e/**/*.js', 'playwright.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
