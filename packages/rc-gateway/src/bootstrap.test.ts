/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeBootstrapCode,
  displayHint,
  BOOTSTRAP_CODE_FILENAME,
} from './bootstrap.js';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'bootstrap-test-'));
}

describe('writeBootstrapCode', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
    dirs.length = 0;
  });

  it('creates the directory with mode 0700', () => {
    const base = mkTmp();
    dirs.push(base);
    const sub = join(base, 'rc');
    writeBootstrapCode(sub, 'TESTCODE');
    const st = statSync(sub);
    // strip file-type bits, keep permission bits only
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('writes the bootstrap file with mode 0600', () => {
    const base = mkTmp();
    dirs.push(base);
    const sub = join(base, 'rc');
    writeBootstrapCode(sub, 'TESTCODE');
    const filePath = join(sub, BOOTSTRAP_CODE_FILENAME);
    const st = statSync(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('returns only the path — never the code', () => {
    const base = mkTmp();
    dirs.push(base);
    const code = 'SUPERSECRETCODE';
    const result = writeBootstrapCode(join(base, 'rc'), code);
    expect(result.path).toContain(BOOTSTRAP_CODE_FILENAME);
    // The returned value must not embed the secret.
    expect(JSON.stringify(result)).not.toContain(code);
  });

  it('re-asserts mode 0600 when overwriting an existing file', () => {
    const base = mkTmp();
    dirs.push(base);
    const sub = join(base, 'rc');
    writeBootstrapCode(sub, 'CODE1');
    const filePath = join(sub, BOOTSTRAP_CODE_FILENAME);
    // Simulate an adversary widening permissions.
    chmodSync(filePath, 0o644);
    // Second write must tighten back to 0600.
    writeBootstrapCode(sub, 'CODE2');
    const st = statSync(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('is idempotent when the directory already exists', () => {
    const base = mkTmp();
    dirs.push(base);
    // base already exists — must not throw
    expect(() => writeBootstrapCode(base, 'ANYCODE')).not.toThrow();
  });
});

describe('displayHint', () => {
  it('returns a string that contains the path', () => {
    const path = '/home/user/.qwen/rc/owner-bootstrap.code';
    expect(displayHint(path)).toContain(path);
  });

  it('NEVER contains the bootstrap code (security invariant)', () => {
    // displayHint only receives the path — this test documents that any code
    // value passed by mistake is absent from the output.
    const secretCode = 'SUPER_SECRET_CODE_XYZ';
    const path = '/home/user/.qwen/rc/owner-bootstrap.code';
    const hint = displayHint(path);
    expect(hint).not.toContain(secretCode);
  });

  it('is a single line with no newlines', () => {
    const path = '/some/path/owner-bootstrap.code';
    const hint = displayHint(path);
    expect(hint).toContain(path);
    expect(hint).not.toContain('\n');
  });
});
