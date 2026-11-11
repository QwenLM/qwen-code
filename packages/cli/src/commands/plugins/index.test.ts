/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/outputListeners.js', () => ({
  initializeOutputListenersAndFlush: vi.fn(),
}));

vi.mock('../../deferred.js', () => ({
  defer: (cmd: Record<string, unknown>) => cmd,
}));

import { createPluginsCommand } from './index.js';

describe('pluginsCommand', () => {
  it('has the expected command signature', () => {
    const cmd = createPluginsCommand();
    expect(cmd.name()).toBe('plugins');
    expect(cmd.aliases()).toContain('plugin');
    expect(cmd.description()).toMatch(/plugin/i);
  });

  it('constructs help without creating a manager or declaring product-only organization flags', () => {
    const command = createPluginsCommand();
    expect(command.helpInformation()).toContain('Manage plugins');
    expect(command.commands.find((child) => child.name() === 'list')?.options.some((option) => option.long === '--org-id')).toBe(false);
  });

  it('registers subcommands', () => {
    const cmd = createPluginsCommand();
    const subcommandNames = cmd.commands.map((c) => c.name());
    expect(subcommandNames).toEqual(
      expect.arrayContaining([
        'list',
        'validate',
        'install',
        'uninstall',
        'enable',
        'disable',
        'update',
        'marketplace',
      ]),
    );
    expect(subcommandNames).not.toContain('check');
    expect(subcommandNames).not.toContain('options');
  });

  it('registers Claude-compatible plugin aliases', () => {
    const cmd = createPluginsCommand();
    const install = cmd.commands.find((c) => c.name() === 'install');
    const uninstall = cmd.commands.find((c) => c.name() === 'uninstall');
    const marketplace = cmd.commands.find((c) => c.name() === 'marketplace');

    expect(install?.aliases()).toContain('i');
    expect(uninstall?.aliases()).toEqual(
      expect.arrayContaining(['remove', 'rm']),
    );
    expect(marketplace?.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(['add', 'list', 'remove', 'update']),
    );
    expect(
      marketplace?.commands.find((c) => c.name() === 'remove')?.aliases(),
    ).toContain('rm');
  });
});
