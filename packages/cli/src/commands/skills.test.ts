/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { skillsCommand } from './skills.js';
import { CommandKind, type CommandContext } from '../ui/commands/types.js';

describe('skills command', () => {
  const mockContext = {} as CommandContext;
  it('should have correct command definition', () => {
    expect(skillsCommand.name).toBe('skill');
    expect(skillsCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(skillsCommand.subCommands).toBeDefined();
    expect(skillsCommand.subCommands?.length).toBeGreaterThan(0);
  });

  it('should register manage and create subcommands', () => {
    const subCommands = skillsCommand.subCommands;
    expect(subCommands).toBeDefined();

    const commandNames = subCommands!.map((cmd) => cmd.name);

    expect(commandNames).toContain('manage');
    expect(commandNames).toContain('create');
  });

  it('subcommands should have correct properties', () => {
    const manageCommand = skillsCommand.subCommands?.find(
      (cmd) => cmd.name === 'manage',
    );
    const createCommand = skillsCommand.subCommands?.find(
      (cmd) => cmd.name === 'create',
    );

    expect(manageCommand).toBeDefined();
    expect(manageCommand?.kind).toBe(CommandKind.BUILT_IN);
    expect(typeof manageCommand?.action).toBe('function');

    expect(createCommand).toBeDefined();
    expect(createCommand?.kind).toBe(CommandKind.BUILT_IN);
    expect(typeof createCommand?.action).toBe('function');
  });

  it('subcommands actions should return correct dialog actions', () => {
    const manageCommand = skillsCommand.subCommands?.find(
      (cmd) => cmd.name === 'manage',
    );
    const createCommand = skillsCommand.subCommands?.find(
      (cmd) => cmd.name === 'create',
    );

    if (manageCommand?.action) {
      const manageResult = manageCommand.action(mockContext, '');
      expect(manageResult).toEqual({
        type: 'dialog',
        dialog: 'skill_list',
      });
    }

    if (createCommand?.action) {
      const createResult = createCommand.action(mockContext, '');
      expect(createResult).toEqual({
        type: 'dialog',
        dialog: 'skill_create',
      });
    }
  });
});
