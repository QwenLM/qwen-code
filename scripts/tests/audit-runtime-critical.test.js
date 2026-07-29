/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { classifyAuditOutput } from '../audit-runtime-critical.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('scripts/audit-runtime-critical.js', () => {
  it('separates a real audit from a registry that never answered', () => {
    // npm exits 1 for BOTH, so the exit code cannot gate a merge on its own.
    // This payload is what the retiring `security/audits/quick` endpoint
    // actually returned on 2026-07-26, when it 400'd for every PR in the repo.
    const endpointFailure = JSON.stringify({
      message:
        '400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Bad Request',
      method: 'POST',
      uri: 'https://registry.npmjs.org/-/npm/v1/security/audits/quick',
      statusCode: 400,
      error: 'Bad Request',
    });
    expect(classifyAuditOutput(endpointFailure)).toBe('unreachable');

    // A real audit always carries the counts, whether or not anything was found.
    const clean = JSON.stringify({
      vulnerabilities: {},
      metadata: { vulnerabilities: { critical: 0, high: 0, total: 0 } },
    });
    expect(classifyAuditOutput(clean)).toBe('audited');

    const vulnerable = JSON.stringify({
      vulnerabilities: { evil: {} },
      metadata: { vulnerabilities: { critical: 2, high: 0, total: 2 } },
    });
    expect(classifyAuditOutput(vulnerable)).toBe('audited');
  });

  it('fails closed on output it does not recognise', () => {
    // If npm changes its payload shape, the gate must go red and get a human
    // to look — never quietly report success and retire itself.
    expect(classifyAuditOutput('')).toBe('unreadable');
    expect(classifyAuditOutput('not json at all')).toBe('unreadable');
    expect(classifyAuditOutput(JSON.stringify({ unexpected: true }))).toBe(
      'unreadable',
    );
    // Shape-only: an object without counts and without an error is NOT an
    // excuse to pass, even though it parses.
    expect(classifyAuditOutput(JSON.stringify({ metadata: {} }))).toBe(
      'unreadable',
    );
  });

  it('still fails the build on a real critical vulnerability', () => {
    // The whole risk of this change is shipping a gate that never fires again.
    // Drive the real script end to end against a stubbed `npm` on PATH, so the
    // exit code being asserted is the one CI would actually see.
    const shimDir = mkdtempSync(join(tmpdir(), 'audit-shim-'));
    const runWithNpmStub = (payload, npmExit) => {
      writeFileSync(
        join(shimDir, 'npm'),
        `#!/usr/bin/env bash\ncat <<'JSON'\n${payload}\nJSON\nexit ${npmExit}\n`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts', 'audit-runtime-critical.js')],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
        },
      );
      return result.status;
    };

    try {
      const counts = (critical) =>
        JSON.stringify({
          vulnerabilities: {},
          metadata: { vulnerabilities: { critical, high: 0, total: critical } },
        });
      // A finding still blocks the merge...
      expect(runWithNpmStub(counts(2), 1)).toBe(1);
      // ...a clean audit still passes...
      expect(runWithNpmStub(counts(0), 0)).toBe(0);
      // ...only an unreachable endpoint is waved through...
      expect(
        runWithNpmStub(
          JSON.stringify({ statusCode: 400, error: 'Bad Request' }),
          1,
        ),
      ).toBe(0);
      // ...and unrecognised output fails closed even when npm exits 0, so a
      // payload-shape change can never silently retire the gate.
      expect(runWithNpmStub('totally not json', 1)).toBe(1);
      expect(runWithNpmStub('totally not json', 0)).toBe(1);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('is wired into the audit script and stays runnable', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['audit:runtime:critical']).toBe(
      'node scripts/audit-runtime-critical.js',
    );
    // Importing the module must not shell out to npm — the main guard is what
    // keeps this test file from running a real audit on import.
    const printed = execFileSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(
          join(root, 'scripts', 'audit-runtime-critical.js'),
        )}).then((m) => console.log(typeof m.classifyAuditOutput))`,
      ],
      { encoding: 'utf8' },
    );
    expect(printed.trim()).toBe('function');
  });
});
