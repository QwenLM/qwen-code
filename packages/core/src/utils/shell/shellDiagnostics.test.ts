/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ShellErrorDiagnostics,
  summarizeShellOutputFile,
} from './shellDiagnostics.js';

describe('shell error diagnostics', () => {
  it('retains error categories and line numbers without command operands or secrets', () => {
    const errors = new ShellErrorDiagnostics();
    const text =
      '/usr/bin/bash: line 11: export PATH=secret-path: No such file or directory\n' +
      'bash: eval: line 2: secret-command: command not found\n' +
      'TOKEN=super-secret arbitrary output\n';
    const bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length; i += 7)
      errors.append(bytes.subarray(i, i + 7));
    expect(errors.summary()).toContain(
      'shell:line=11:No such file or directory',
    );
    expect(errors.summary()).toContain('eval:line=2:command not found');
    expect(errors.summary()).toContain(`stderr_bytes=${bytes.length}`);
    expect(errors.summary()).not.toMatch(/secret|TOKEN|export PATH/);
  });

  it('bounds a large stream while keeping its first and last errors', () => {
    const errors = new ShellErrorDiagnostics();
    errors.append('bash: line 1: syntax error\n');
    for (let i = 0; i < 100; i++) errors.append('x'.repeat(10000));
    errors.append('\nbash: line 77: Permission denied\n');
    expect(errors.summary()).toContain('stderr_truncated=true');
    expect(errors.summary()).toContain('line=1:syntax error');
    expect(errors.summary()).toContain('line=77:Permission denied');
    expect(errors.summary().length).toBeLessThan(500);
  });

  it('reads bounded file-mode diagnostics without logging stdout content', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shell-diag-'));
    try {
      const file = path.join(directory, 'output');
      await writeFile(
        file,
        'secret stdout\n' +
          'x'.repeat(10000) +
          '\nbash: line 9: command not found\n',
      );
      const summary = summarizeShellOutputFile(file);
      expect(summary).toContain('output_truncated=true');
      expect(summary).toContain('line=9:command not found');
      expect(summary).not.toContain('secret');
      expect(() => summarizeShellOutputFile(directory)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
