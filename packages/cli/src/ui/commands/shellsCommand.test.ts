/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { shellsCommand } from './shellsCommand.js';
import { ShellProcessRegistry } from '@qwen-code/qwen-code-core';

describe('shellsCommand', () => {
  beforeEach(() => {
    ShellProcessRegistry.resetInstance();
  });

  it('should have correct name', () => {
    expect(shellsCommand.name).toBe('shells');
  });

  it('should have altNames', () => {
    expect(shellsCommand.altNames).toContain('processes');
    expect(shellsCommand.altNames).toContain('bg');
  });

  it('should have output subcommand', () => {
    const outputCmd = shellsCommand.subCommands?.find(
      (s) => s.name === 'output',
    );
    expect(outputCmd).toBeDefined();
  });

  it('should have kill subcommand', () => {
    const killCmd = shellsCommand.subCommands?.find((s) => s.name === 'kill');
    expect(killCmd).toBeDefined();
  });

  it('should have stats subcommand', () => {
    const statsCmd = shellsCommand.subCommands?.find((s) => s.name === 'stats');
    expect(statsCmd).toBeDefined();
  });
});
