/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { LspConnectionFactory } from './LspConnectionFactory.js';

describe('LspConnectionFactory', () => {
  it('captures stderr and exit code when stdio server closes during initialize', async () => {
    const connection = await LspConnectionFactory.createStdioConnection(
      process.execPath,
      [
        '-e',
        'process.stderr.write("clangd failed before initialize\\n"); process.exit(7);',
      ],
    );

    await expect(connection.connection.initialize({})).rejects.toThrow(
      'LSP connection closed',
    );

    if (!connection.processDiagnostics) {
      throw new Error('Expected process diagnostics for stdio connection');
    }
    const diagnostics = connection.processDiagnostics;

    expect(diagnostics.stderrTail).toContain('clangd failed before initialize');
    expect(diagnostics.exitCode).toBe(7);
    expect(diagnostics.exitSignal).toBeNull();
  });

  it('preserves UTF-8 characters split across stderr chunks', async () => {
    const connection = await LspConnectionFactory.createStdioConnection(
      process.execPath,
      [
        '-e',
        [
          'process.stderr.write(Buffer.from([0xe2]));',
          'setTimeout(() => {',
          'process.stderr.write(Buffer.from([0x98, 0x83, 0x0a]));',
          'process.exit(7);',
          '}, 10);',
        ].join(''),
      ],
    );

    await expect(connection.connection.initialize({})).rejects.toThrow(
      'LSP connection closed',
    );

    expect(connection.processDiagnostics?.stderrTail).toContain('☃');
  });
});
