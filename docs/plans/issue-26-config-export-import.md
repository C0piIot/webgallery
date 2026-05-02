# Plan — Issue #26: Export / import bucket configuration as JSON

## Scope (in / out)

**In**
- **Export**: a button on `setup-storage.html` that downloads `webgallery-config-{YYYY-MM-DD}.json` containing the saved config, after a `confirm()` warning the file contains plaintext credentials.
- **Import**: a button + hidden file input that reads a JSON file, validates the schema, and populates the form fields. User still clicks Test/Save to commit it.
- A schema version (`schemaVersion: 1`) so the import path can reject unknown versions cleanly.
- Pure serialize/parse helpers in `lib/config.js` so the schema handling is unit-testable.

**Out (deferred)**
- Encrypted export (passphrase-wrapped). Out per issue body.
- Folder export (FSA handles aren't useful across devices). Out per issue body.
- Inline validation errors on the form during Import. The form already shows errors at Test/Save time; importing just fills values, validation rides the existing path.

## Approach

### 1. Pure helpers in `lib/config.js`

Add `serializeConfigForExport(config)` (whitelists known fields, stamps `schemaVersion`), `parseImportedConfig(text)` (JSON parse, schemaVersion check, returns the inner `config`), and a `ConfigImportError` class for typed error surfacing.

### 2. UI on `setup-storage.html`

After the existing Test/Save buttons, an always-visible Bootstrap warning alert + an Export button + an Import button paired with a hidden `<input type="file" accept="application/json">`. The warning is shown regardless of whether the user clicks Export so they see the risk before deciding.

### 3. Wiring in `setup-storage.js`

- Export: `confirm()` → `Blob` → `URL.createObjectURL` → `<a download>.click()` → revoke URL.
- Import: read file → `parseImportedConfig` → `applyConfigToForm` (the helper already used by the existing bootstrap-from-saved-config path) → reset the file input's value so re-importing the same file works.
- Errors surface in the existing `resultPane`.

### 4. SW shell

`setup-storage.html` + `setup-storage.js` + `lib/config.js` content changes. All already in `SHELL`. Bump `sw.js` `VERSION` v23 → v24.

## Tests

### Unit — `tests/lib/config.test.js`

- `serializeConfigForExport`: known fields only; missing fields default to empty / false; `schemaVersion: 1` stamped.
- `parseImportedConfig`: round-trip from serialize; rejects invalid JSON, missing schemaVersion, wrong schemaVersion, missing/non-object config.

### E2E — `e2e/setup-storage.spec.js`

- **Export**: prefill MINIO, accept the `confirm()`, click Export, capture download, read file, assert `schemaVersion === 1` and `config.endpoint` matches.
- **Import**: `setInputFiles` on the hidden input with a known-good JSON buffer, assert form fields are populated, assert success copy in the result pane.
- **Bad import**: feed `{schemaVersion: 999, config: {}}`, assert error in the result pane.

## Files

**Created**
- `docs/plans/issue-26-config-export-import.md` (this file).

**Modified**
- `lib/config.js` — export helpers + `ConfigImportError`.
- `setup-storage.html` — warning alert, Export/Import buttons, hidden file input.
- `setup-storage.js` — `onExport`, `onImport`, hooks.
- `tests/lib/config.test.js` — round-trip + error cases.
- `e2e/setup-storage.spec.js` — Export / Import / bad-import flows.
- `sw.js` — `VERSION` v23 → v24.
- `docs/plans/README.md` — index entry for #26.

## Verification

1. `make lint` / `make test` — new unit tests; existing 113 still pass.
2. `make e2e` — 27 → 30 (3 new tests).
3. Manual smoke at deploy: configure on laptop, Export, transfer file to phone, Import, verify the form fills out, Save → bucket connects.

## Risks

- **`d-none` file input + `setInputFiles`**: Playwright targets DOM elements regardless of visibility. If a CI version misbehaves, swap `d-none` for `visually-hidden` styling.
- **Warning fatigue**: alert + confirm may feel paternalistic but credentials-on-disk warrants belt + suspenders. If users push back, drop the confirm() and rely on the alert alone.
