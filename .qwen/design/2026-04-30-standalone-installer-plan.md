# Standalone Installer Implementation Plan

**Goal:** Add code-server-style standalone archive distribution with npm fallback.

**Architecture:** Release builds produce per-platform archives that bundle
`dist/cli.js`, required runtime assets, and a private Node.js runtime. The
installer defaults to `detect`, installs a standalone archive when available,
and falls back to npm otherwise.

**Tech Stack:** Bash, Windows batch, Node.js release scripting, GitHub Actions,
Vitest static/smoke tests.

## Task 1: Installer Contract Tests

**Files:**

- Modify: `scripts/tests/install-script.test.js`

**Steps:**

1. Add tests asserting the Unix installer exposes `--method`, `--mirror`,
   `--base-url`, `--archive`, standalone install functions, checksum
   verification, and npm fallback.
2. Add tests asserting the Windows installer exposes the same options and uses
   PowerShell/CertUtil for archive install and checksum verification.
3. Run `npm run test:scripts`.
4. Confirm the new tests fail before implementation.

## Task 2: Standalone Package Script

**Files:**

- Create: `scripts/create-standalone-package.js`
- Modify: `package.json`

**Steps:**

1. Add a Node.js script that accepts `--target`, `--node-archive`,
   `--out-dir`, and optional `--version`.
2. Require `dist/cli.js`, `dist/vendor`, `README.md`, and `LICENSE`.
3. Extract a Node.js distribution archive into a staging directory.
4. Create `qwen-code/bin/qwen`, `qwen-code/bin/qwen.cmd`,
   `qwen-code/lib/cli.js`, copied runtime assets, and `manifest.json`.
5. Emit `qwen-code-<target>.tar.gz` for Unix targets and
   `qwen-code-<target>.zip` for Windows targets.
6. Write/update `SHA256SUMS`.
7. Add `npm run package:standalone`.
8. Add focused script tests where practical.

## Task 3: Unix Installer Standalone Flow

**Files:**

- Modify: `scripts/installation/install-qwen-with-source.sh`

**Steps:**

1. Add argument parsing for `--method`, `--mirror`, `--base-url`, `--archive`,
   and `--version`.
2. Add target detection for supported OS/arch combinations.
3. Add URL construction for GitHub and Aliyun mirrors.
4. Add archive availability check for detect mode.
5. Add download, checksum verification, extraction, and shim creation.
6. Keep npm installation as fallback and as explicit `--method npm`.
7. Keep source tracking and final instructions.

## Task 4: Windows Installer Standalone Flow

**Files:**

- Modify: `scripts/installation/install-qwen-with-source.bat`

**Steps:**

1. Add argument parsing for `--method`, `--mirror`, `--base-url`, `--archive`,
   and `--version`.
2. Add target detection for `win-x64`.
3. Add archive download with PowerShell.
4. Add checksum verification with `certutil`.
5. Add archive extraction with PowerShell `Expand-Archive`.
6. Install to `%LOCALAPPDATA%\qwen-code\qwen-code` and expose
   `%LOCALAPPDATA%\qwen-code\bin\qwen.cmd`.
7. Keep npm fallback and source tracking.

## Task 5: Release Workflow

**Files:**

- Modify: `.github/workflows/release.yml`

**Steps:**

1. After `npm run prepare:package`, download supported Node.js runtime
   archives.
2. Run `npm run package:standalone -- --target ...` for each supported target.
3. Upload `dist/standalone/qwen-code-*` and `dist/standalone/SHA256SUMS` to the
   GitHub Release alongside `dist/cli.js`.

## Task 6: Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/users/overview.md`
- Modify: `docs/users/quickstart.md`
- Modify: `scripts/installation/INSTALLATION_GUIDE.md`
- Create: `.qwen/e2e-tests/2026-04-30-standalone-installer-test-plan.md`

**Steps:**

1. Document install methods and mirror choices.
2. Document offline archive installation.
3. Document release artifact names.
4. Document platform verification plan.

## Task 7: Verification

**Commands:**

- `npm run test:scripts`
- `npx prettier --check README.md docs/users/quickstart.md docs/users/overview.md scripts/installation/INSTALLATION_GUIDE.md .qwen/design/2026-04-30-standalone-installer-design.md .qwen/design/2026-04-30-standalone-installer-plan.md .qwen/e2e-tests/2026-04-30-standalone-installer-test-plan.md scripts/tests/install-script.test.js`
- `bash -n scripts/installation/install-qwen-with-source.sh`
- `git diff --check`
- Local fake-runtime installer smoke for npm and standalone paths.
