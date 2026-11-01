/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

// Avoid writing per-session debug log files during CLI tests.
// Individual tests can still opt in by overriding this env var explicitly.
if (process.env['QWEN_DEBUG_LOG_FILE'] === undefined) {
  process.env['QWEN_DEBUG_LOG_FILE'] = '0';
}

if (process.env['QWEN_SERVE_NO_PERSISTENT_REGISTRATION'] === undefined) {
  process.env['QWEN_SERVE_NO_PERSISTENT_REGISTRATION'] = '1';
}

// Model limits and modalities come from the regex tables unless a test opts
// into the models.dev catalog.
process.env['QWEN_CODE_MODELS_DEV'] = 'off';

// The review sandbox policy is the OPERATOR's setting for their own reviews,
// and this suite must not inherit it. A maintainer who turns the feature on
// and then runs `npm test` would otherwise watch the review tests refuse to
// run — 101 of them, measured — because the phase gates correctly do what the
// setting says. Deleting rather than pinning to a value, so `sandboxPolicy`'s
// "strictest of environment and settings" rule is left alone and a test that
// wants a policy still stubs one.
delete process.env['QWEN_REVIEW_SANDBOX'];
delete process.env['SANDBOX_SET_UID_GID'];

// QWEN_RUNTIME_DIR is the OPERATOR's runtime root, and it outranks
// Storage.setRuntimeBaseDir (config/storage.ts:169). Exported on a developer
// run, any test relying on that static override alone reads and writes the
// ambient runtime root instead of its own temp dir. Deleting rather than
// pinning: tests that want the variable set it in-body.
delete process.env['QWEN_RUNTIME_DIR'];

import { EXTRACT_NOOP_SKIP_TURNS_ENV } from '@qwen-code/qwen-code-core/memory/extract-cadence.js';

// The extraction-cadence experiment is default-off and its gate reads
// process.env on every call, so an ambient export would switch it on for every
// suite whose session schedules an extraction. Deleting rather than pinning:
// tests that exercise the experiment stub the variable in-body.
delete process.env[EXTRACT_NOOP_SKIP_TURNS_ENV];

// Registration capacity is an OPERATOR daemon setting, and `createServeApp` /
// `runQwenServe` read it straight from the ambient environment when no explicit
// option or `daemonEnv` is supplied. A maintainer who exports the documented
// downgrade value would otherwise turn the capacity assertions red, and an
// invalid value would throw at app construction, failing every test that builds
// one. Deleting rather than pinning, so tests that want a capacity still pass
// one explicitly.
delete process.env['QWEN_SERVE_MAX_WORKSPACES'];

// QWEN_HOME is the OPERATOR's settings home, and this suite must not read it:
// the verification gate runs with the host's real HOME on a machine shared
// with other jobs, and a malformed $HOME/.qwen/settings.json there fails
// every operator-settings reader at once — readOperatorSettingsScopes fails
// closed by design (one polluted file failed 408 tests across 15 files in a
// measured gate run). The pin is unconditional: this repo's own agent gates
// export QWEN_HOME on steps that allowlist vitest, and honoring an ambient
// home reopens the mass-failure mode above and lets settings-writing tests
// write into the agent's live home (both measured on this suite). Tests that
// exercise QWEN_HOME set, stub, or delete it themselves.
const QWEN_HOME_PIN_PREFIX = 'qwen-cli-test-';
// A live pin is seconds old — one per test-file worker — so anything older
// than an hour is a leak from a terminated run, never a directory a live
// suite is using.
const QWEN_HOME_PIN_MAX_AGE_MS = 60 * 60 * 1000;

export function pinQwenHome(env: NodeJS.ProcessEnv): string {
  // The pinned value must stay non-empty: every production reader gates on
  // truthiness (Storage.getGlobalQwenDir does `if (envDir)`), so an ambient
  // empty string must be pinned over rather than falling through to
  // $HOME/.qwen.
  const qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), QWEN_HOME_PIN_PREFIX));
  env['QWEN_HOME'] = qwenHome;
  return qwenHome;
}

// Reclaim pins leaked by earlier runs. Vitest workers are terminated, not
// exited, so a `process.on('exit')` cleanup never runs; and the pin must NOT
// be deleted at teardown either — an afterAll sweep of the live pin raced
// un-awaited extension-store work still reading it (the required ubuntu check
// went red on ENOENT in extension-store/transactions). So the pin stays alive
// for the process lifetime and reaping happens here, by age, before the new
// pin is created. Best-effort: a reaper failure must never fail setup.
export function reapStaleQwenHomePins(now: number = Date.now()): void {
  let names: string[];
  try {
    names = fs
      .readdirSync(os.tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(QWEN_HOME_PIN_PREFIX)) continue;
    try {
      const pin = path.join(os.tmpdir(), name);
      if (now - fs.statSync(pin).mtimeMs < QWEN_HOME_PIN_MAX_AGE_MS) continue;
      fs.rmSync(pin, { recursive: true, force: true });
    } catch {
      // A sibling run may hold or have just removed the directory; reaping
      // leaked pins is hygiene and must not fail the suite's setup.
    }
  }
}

reapStaleQwenHomePins();
const suiteQwenHome: string = pinQwenHome(process.env);

import { configure } from '@testing-library/react';
import { afterAll, afterEach, beforeEach } from 'vitest';

import './src/test-utils/customMatchers.js';

// Teardown witness: the pin must outlive every test file's hooks. Vitest
// runs root-level afterAll hooks in reverse registration order (measured on
// this repo's vitest), and this hook is the first root afterAll this file
// registers, so it runs LAST — a teardown sweep of the live pin reintroduced
// anywhere below runs before it and turns every file red here. A test-file
// afterAll cannot witness this: it runs BEFORE the setup file's root
// afterAll. Tests that reassign process.env['QWEN_HOME'] do not move the
// closure variable this checks.
afterAll(() => {
  if (!fs.existsSync(suiteQwenHome)) {
    throw new Error(
      `QWEN_HOME pin ${suiteQwenHome} was deleted during the test file run; ` +
        'the pin must stay alive for the process lifetime (see the pin ' +
        'comment above).',
    );
  }
});

// Give every test its own autofix anchor dir so anchors never leak between
// tests or onto the host's real ~/.qwen; a test confirms an anchor for its
// clone via writeAnchor in its own beforeEach. Capture the base root at module
// load, BEFORE any suite repoints TMPDIR/TEMP/TMP (script-lint-isolation does,
// to exercise a fail-closed path): os.tmpdir() inside a beforeEach would then
// throw ENOENT before the test body runs.
const autofixAnchorBase = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autofix-anchor-base-'),
);
let autofixAnchorDir: string | undefined;
beforeEach(() => {
  autofixAnchorDir = fs.mkdtempSync(path.join(autofixAnchorBase, 'case-'));
  process.env['QWEN_AUTOFIX_ANCHOR_DIR'] = autofixAnchorDir;
});
afterEach(() => {
  if (autofixAnchorDir) {
    fs.rmSync(autofixAnchorDir, { recursive: true, force: true });
  }
  autofixAnchorDir = undefined;
  delete process.env['QWEN_AUTOFIX_ANCHOR_DIR'];
});

// Capture the real timer so sync-heavy suites can drain worker RPC replies.
const realSetTimeout = setTimeout;
beforeEach(() => new Promise<void>((resolve) => realSetTimeout(resolve, 0)));

// CI and the autofix verification gate run this suite on a shared,
// oversubscribed host, where the testing-library default 1s async budget is
// spent on neighbour load rather than on the code under test (the gate's
// 60s testTimeout cannot help: waitFor has its own default). Give async
// queries room there only — locally the 1s default keeps failures fast.
// Assertions are untouched: a condition that never holds still fails.
if (process.env['CI']) {
  configure({ asyncUtilTimeout: 10_000 });
}

// Lowlight is loaded asynchronously in production to keep it out of the
// startup-critical bundle chunk. Snapshot tests render synchronously via
// `lastFrame()` and would otherwise capture the plain-text fallback before
// the dynamic import resolves. Prime the cache once here so every test sees
// the fully-highlighted output. The loader is intentionally a tiny standalone
// module (no transitive imports of themeManager / settings / core) so this
// prime does not perturb any other test's module graph.
import { loadLowlight } from './src/ui/utils/lowlightLoader.js';
try {
  await loadLowlight();
} catch (err) {
  // Don't crash the entire test run if lowlight fails to import; snapshot
  // tests that hit a code block will then render the plain-text fallback.
  console.warn(
    '[test-setup] Failed to prime lowlight cache, snapshot tests may ' +
      'show plain-text fallback:',
    String(err),
  );
}
