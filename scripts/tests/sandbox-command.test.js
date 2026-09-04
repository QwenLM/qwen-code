/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'sandbox_command.js',
);

/**
 * Runs sandbox_command.js as a subprocess with the given QWEN_SANDBOX value.
 * Returns { status, stdout, stderr }. Never throws on a non-zero exit so the
 * caller can assert on the exit code.
 */
function runSandboxCommand(sandboxValue) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, '-q'], {
      encoding: 'utf8',
      env: { ...process.env, QWEN_SANDBOX: sandboxValue },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

describe('sandbox_command.js QWEN_SANDBOX handling', () => {
  // Each payload appends a command that would exit 0 if the shell ever split
  // the value on the metacharacter. A vulnerable build runs e.g.
  // `command -v doesnotexist; true`, which exits 0, so commandExists() returns
  // true and the script echoes the payload and exits 0. The hardened build
  // treats the whole string as a single command name, fails to find it, and
  // exits non-zero — so a regression here flips these assertions.
  const injectionPayloads = [
    'doesnotexist; true',
    'doesnotexist && true',
    'doesnotexist | true',
    'doesnotexist; echo pwned',
    '$(true)',
    '`true`',
  ];

  for (const payload of injectionPayloads) {
    it(`rejects the injection payload ${JSON.stringify(payload)} instead of executing it`, () => {
      const { status, stdout } = runSandboxCommand(payload);
      expect(status).not.toBe(0);
      // The payload must never be accepted as a resolved sandbox command.
      expect(stdout.trim()).toBe('');
    });
  }

  it('reports the raw value as a single missing command (no shell splitting)', () => {
    const payload = 'doesnotexist; echo pwned';
    const { status, stderr } = runSandboxCommand(payload);
    expect(status).not.toBe(0);
    // The entire string is echoed back verbatim, proving it was treated as one
    // opaque command name rather than parsed by a shell.
    expect(stderr).toContain(`missing sandbox command '${payload}'`);
  });
});
