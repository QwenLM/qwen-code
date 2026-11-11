/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { marketplaceCommand, pluginsCommand } from './pluginsCommand.js';

describe('plugins slash command', () => {
  it('registers direct text subcommands', () => {
    const names = pluginsCommand.subCommands?.map((cmd) => cmd.name) ?? [];

    expect(pluginsCommand.name).toBe('plugins');
    expect(pluginsCommand.altNames).toContain('plugin');
    expect(names).toEqual(
      expect.arrayContaining([
        'install',
        'uninstall',
        'enable',
        'disable',
        'update',
        'validate',
        'marketplace',
        'reload',
      ]),
    );
  });

  it('registers slash aliases for plugin and marketplace flows', () => {
    const subcommands = pluginsCommand.subCommands ?? [];
    const install = subcommands.find((cmd) => cmd.name === 'install');
    const uninstall = subcommands.find((cmd) => cmd.name === 'uninstall');
    const marketplace = subcommands.find((cmd) => cmd.name === 'marketplace');
    const reload = subcommands.find((cmd) => cmd.name === 'reload');

    expect(install?.altNames).toContain('i');
    expect(uninstall?.altNames).toEqual(expect.arrayContaining(['remove', 'rm']));
    expect(marketplace?.altNames).toContain('market');
    expect(reload?.altNames ?? []).not.toContain('refresh');
    expect(marketplace?.subCommands?.map((cmd) => cmd.name)).toEqual(
      expect.arrayContaining(['add', 'list', 'remove', 'update']),
    );
    expect(
      marketplace?.subCommands?.find((cmd) => cmd.name === 'remove')?.altNames,
    ).toContain('rm');
  });

  it('registers top-level marketplace slash command', () => {
    expect(marketplaceCommand.name).toBe('marketplace');
    expect(marketplaceCommand.hidden).toBe(true);
    expect(marketplaceCommand.subCommands?.map((cmd) => cmd.name)).toEqual(
      expect.arrayContaining(['add', 'list', 'remove', 'update']),
    );
  });
});
