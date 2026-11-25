/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from '@commander-js/extra-typings';
import { createCommandDeclarations } from './command-declarations.js';

function terminalCommands() {
  return createCommandDeclarations().flatMap(
    (declaration) => declaration.getTerminalCommands?.() ?? [],
  ) as Command[];
}

describe('createCommandDeclarations', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('declares only the serve and channel placeholders', () => {
    expect(terminalCommands().map((command) => command.name())).toEqual([
      'serve',
      'channel',
    ]);
  });

  it.each([
    ['serve', ['--port', '8080', 'extra']],
    ['channel', ['start', 'telegram']],
    ['serve', ['--help']],
  ])(
    '`qwen %s %s` explains it is unsupported and exits 1',
    async (name, args) => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const program = new Command('qwen').exitOverride();
      for (const command of terminalCommands()) program.addCommand(command);

      await program.parseAsync([name, ...args], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(`\`qwen ${name}\` is not supported`),
      );
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('npm i -g @qwen-code/qwen-code@latest'),
      );
    },
  );
});
