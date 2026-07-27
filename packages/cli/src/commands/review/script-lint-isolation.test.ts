/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The hadolint config-isolation FAIL-CLOSED guard, in its own file on purpose.
//
// `emptyHadolintConfig()` caches its result at module scope, so once any earlier test
// in a shared file has warmed the cache the failure path is unreachable — no stub can
// reach it there. vitest gives each file a fresh module registry, so this file points
// `TMPDIR` at a path that does not exist BEFORE importing script-lint; the very first
// `emptyHadolintConfig()` call then fails to `mkdtempSync`, and the guard fires.
//
// Two properties, deliberately split so a mutation attributes cleanly:
//   1. buildToolInvocation adds no `--config` — the argv logic; holds with or
//      without the guard.
//   2. runScriptLint fails the hadolint run CLOSED (errored, ok=false) — THIS is the
//      guard. Delete `if (tool === 'hadolint' && !emptyHadolintConfig())` and the run
//      falls through to a real hadolint invocation, so #2 reddens and #1 stays green.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `os.tmpdir()` reads TMPDIR on POSIX but TEMP/TMP on Windows — override all three
// so the "no private config could be created" path is exercised on every platform,
// not left vacuous on the Windows job.
const TMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;
const savedTmp: Record<string, string | undefined> = {};
let workDir: string;

beforeAll(() => {
  // A real dir to hold the plan/worktree (built with absolute paths, so it does not
  // depend on the temp vars), created BEFORE we break them.
  workDir = mkdtempSync(join(tmpdir(), 'iso-'));
  const nope = join(workDir, 'nope') + '/'; // a path that does not exist
  for (const v of TMP_VARS) {
    savedTmp[v] = process.env[v];
    // → `os.tmpdir()` returns it, and `mkdtempSync(join(tmpdir(), …))` inside
    //   emptyHadolintConfig hits ENOENT and throws: the fail-closed path.
    process.env[v] = nope;
  }
});

afterAll(() => {
  for (const v of TMP_VARS) {
    if (savedTmp[v] === undefined) delete process.env[v];
    else process.env[v] = savedTmp[v];
  }
});

describe('script-lint — hadolint fails closed when config isolation is unavailable', () => {
  it('adds no --config when a private neutral config cannot be created', async () => {
    const { buildToolInvocation } = await import('./script-lint.js');
    // No private config → no `--config` on the argv (and the run fails closed below,
    // so hadolint never lints unisolated against a cwd `.hadolint.yaml`).
    expect(buildToolInvocation('hadolint', '/w/Dockerfile').argv).not.toContain(
      '--config',
    );
  });

  it('errors a Dockerfile (fail closed) instead of linting it unisolated', async () => {
    const { runScriptLint } = await import('./script-lint.js');
    const wt = join(workDir, 'repo');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'Dockerfile'), 'FROM alpine\nRUN echo hi\n');
    const plan = join(wt, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({ files: [{ path: 'Dockerfile', kind: 'source' }] }),
    );

    const r = runScriptLint({ plan, worktree: wt });
    // Not linted against a config we cannot vouch for: errored, not checked, ok false.
    expect(r.checked).toEqual([]);
    expect(r.errored).toHaveLength(1);
    expect(r.errored[0].tool).toBe('hadolint');
    expect(r.errored[0].reason).toContain('isolation');
    expect(r.ok).toBe(false);
  });
});
