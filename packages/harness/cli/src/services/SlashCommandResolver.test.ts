/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SlashCommandResolver } from './SlashCommandResolver.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

const createMockCommand = (name: string, kind: CommandKind): SlashCommand => ({
  name,
  description: `Description for ${name}`,
  kind,
  action: vi.fn(),
});

describe('SlashCommandResolver', () => {
  describe('resolve', () => {
    it('should return all commands when there are no conflicts', () => {
      const cmdA = createMockCommand('a', CommandKind.BUILT_IN);
      const cmdB = createMockCommand('b', CommandKind.SKILL);

      const { finalCommands, conflicts } = SlashCommandResolver.resolve([
        cmdA,
        cmdB,
      ]);

      expect(finalCommands).toHaveLength(2);
      expect(conflicts).toHaveLength(0);
    });

    it('should rename extension skill commands when they conflict with built-in', () => {
      const builtin = createMockCommand('deploy', CommandKind.BUILT_IN);
      const extension = {
        ...createMockCommand('firebase:deploy', CommandKind.SKILL),
        pluginName: 'firebase',
      };

      const { finalCommands, conflicts } = SlashCommandResolver.resolve([
        builtin,
        extension,
      ]);

      expect(finalCommands.map((c) => c.name)).toContain('deploy');
      expect(finalCommands.map((c) => c.name)).toContain('firebase:deploy');
      expect(conflicts).toHaveLength(0);
    });

    it('should keep distinct already-prefixed plugin skills', () => {
      const skill1 = {
        ...createMockCommand('ext-a:sync', CommandKind.SKILL),
        pluginName: 'ext-a',
      };
      const skill2 = {
        ...createMockCommand('ext-b:sync', CommandKind.SKILL),
        pluginName: 'ext-b',
      };

      const { finalCommands } = SlashCommandResolver.resolve([skill1, skill2]);

      const names = finalCommands.map((c) => c.name);
      expect(names).not.toContain('sync');
      expect(names).toContain('ext-a:sync');
      expect(names).toContain('ext-b:sync');
    });

    it('should prefix skill commands but keep built-in names during conflicts', () => {
      const builtin = createMockCommand('help', CommandKind.BUILT_IN);
      const skill = createMockCommand('help', CommandKind.SKILL);

      const { finalCommands } = SlashCommandResolver.resolve([builtin, skill]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('help');
      expect(names).toContain('help1');
    });

    it('should prefix dynamic commands when they conflict with built-in', () => {
      const builtin = createMockCommand('review', CommandKind.BUILT_IN);
      const dynamic = createMockCommand('review', CommandKind.DYNAMIC);

      const { finalCommands } = SlashCommandResolver.resolve([builtin, dynamic]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('review');
      expect(names).toContain('dynamic.review');
    });

    it('should favor the last built-in command silently during conflicts', () => {
      const builtin1 = {
        ...createMockCommand('help', CommandKind.BUILT_IN),
        description: 'first',
      };
      const builtin2 = {
        ...createMockCommand('help', CommandKind.BUILT_IN),
        description: 'second',
      };

      const { finalCommands } = SlashCommandResolver.resolve([
        builtin1,
        builtin2,
      ]);

      expect(finalCommands).toHaveLength(1);
      expect(finalCommands[0].description).toBe('second');
    });

    it('should fallback to numeric suffixes when both prefix and kind-based prefix are missing', () => {
      const cmd1 = createMockCommand('test', CommandKind.BUILT_IN);
      const cmd2 = {
        ...createMockCommand('test', 'unknown' as CommandKind),
      };

      const { finalCommands } = SlashCommandResolver.resolve([cmd1, cmd2]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('test');
      expect(names).toContain('test1');
    });

    it('should apply numeric suffixes when renames also conflict', () => {
      const skill1 = createMockCommand('deploy', CommandKind.SKILL);
      const skill2 = createMockCommand('gcp:deploy', CommandKind.SKILL);
      const extension = {
        ...createMockCommand('gcp:deploy', CommandKind.SKILL),
        pluginName: 'gcp',
      };

      const { finalCommands } = SlashCommandResolver.resolve([
        skill1,
        skill2,
        extension,
      ]);

      expect(finalCommands.find((c) => c.name === 'gcp:deploy1')).toBeDefined();
    });

    it('should prefix skills with extension name when they conflict with built-in', () => {
      const builtin = createMockCommand('chat', CommandKind.BUILT_IN);
      const skill = {
        ...createMockCommand('google-workspace:chat', CommandKind.SKILL),
        pluginName: 'google-workspace',
      };

      const { finalCommands } = SlashCommandResolver.resolve([builtin, skill]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('chat');
      expect(names).toContain('google-workspace:chat');
    });

    it('should keep already-prefixed extension skills when no conflict exists', () => {
      const skill = {
        ...createMockCommand('google-workspace:chat', CommandKind.SKILL),
        pluginName: 'google-workspace',
      };

      const { finalCommands } = SlashCommandResolver.resolve([skill]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('google-workspace:chat');
      expect(names).not.toContain('chat');
    });

    it('should use numeric suffixes if prefixed skill names collide', () => {
      const skill1 = {
        ...createMockCommand('google-workspace:chat', CommandKind.SKILL),
        pluginName: 'google-workspace',
      };
      const skill2 = {
        ...createMockCommand('google-workspace:chat', CommandKind.SKILL),
        pluginName: 'google-workspace',
      };

      const { finalCommands } = SlashCommandResolver.resolve([skill1, skill2]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('google-workspace:chat');
      expect(names).toContain('google-workspace:chat1');
    });

    it('should NOT prefix skills with "skill" when extension name is missing', () => {
      const builtin = createMockCommand('chat', CommandKind.BUILT_IN);
      const skill = createMockCommand('chat', CommandKind.SKILL);

      const { finalCommands } = SlashCommandResolver.resolve([builtin, skill]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('chat');
      expect(names).toContain('chat1');
    });

    it('lets same-plugin commands shadow same-named plugin skills silently', () => {
      const skill = {
        ...createMockCommand('ecc:orch-add-feature', CommandKind.SKILL),
        pluginName: 'ecc',
      };
      const command = {
        ...createMockCommand('ecc:orch-add-feature', CommandKind.PLUGIN),
        pluginName: 'ecc',
      };

      const { finalCommands, conflicts } = SlashCommandResolver.resolve([
        skill,
        command,
      ]);

      expect(finalCommands).toHaveLength(1);
      expect(finalCommands[0]).toMatchObject({
        name: 'ecc:orch-add-feature',
        kind: CommandKind.PLUGIN,
      });
      expect(conflicts).toHaveLength(0);
    });

    it('drops same-plugin skills when the plugin command was loaded first', () => {
      const command = {
        ...createMockCommand('ecc:orch-add-feature', CommandKind.PLUGIN),
        pluginName: 'ecc',
      };
      const skill = {
        ...createMockCommand('ecc:orch-add-feature', CommandKind.SKILL),
        pluginName: 'ecc',
      };

      const { finalCommands, conflicts } = SlashCommandResolver.resolve([
        command,
        skill,
      ]);

      expect(finalCommands).toHaveLength(1);
      expect(finalCommands[0]).toMatchObject({
        name: 'ecc:orch-add-feature',
        kind: CommandKind.PLUGIN,
      });
      expect(conflicts).toHaveLength(0);
    });

    it('keeps source-qualified plugin commands when plugin workflows collide', () => {
      const command = {
        ...createMockCommand('ecc:orch-review', CommandKind.PLUGIN),
        pluginName: 'ecc',
      };
      const workflow = createMockCommand(
        'ecc:orch-review',
        CommandKind.WORKFLOW,
      );

      const { finalCommands, conflicts } = SlashCommandResolver.resolve([
        command,
        workflow,
      ]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('ecc:orch-review');
      expect(names).toContain('workflow.ecc:orch-review');
      expect(names).not.toContain('ecc:orch-review1');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].losers[0]).toMatchObject({
        command: expect.objectContaining({ kind: CommandKind.WORKFLOW }),
        renamedTo: 'workflow.ecc:orch-review',
      });
    });

    it('keeps source-qualified plugin skills when later commands collide', () => {
      const skill = {
        ...createMockCommand('firebase:deploy', CommandKind.SKILL),
        pluginName: 'firebase',
      };
      const workflow = createMockCommand(
        'firebase:deploy',
        CommandKind.WORKFLOW,
      );

      const { finalCommands, conflicts } = SlashCommandResolver.resolve([
        skill,
        workflow,
      ]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('firebase:deploy');
      expect(names).toContain('workflow.firebase:deploy');
      expect(names).not.toContain('firebase:deploy1');
      expect(
        finalCommands.find((c) => c.name === 'firebase:deploy')?.kind,
      ).toBe(CommandKind.SKILL);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].losers[0]).toMatchObject({
        command: expect.objectContaining({ kind: CommandKind.WORKFLOW }),
        renamedTo: 'workflow.firebase:deploy',
      });
    });

    it('never renames mcp__ namespaced MCP prompts (structural isolation)', () => {
      const mcp = {
        ...createMockCommand('mcp__server__deploy', CommandKind.MCP_PROMPT),
        displayName: 'server:deploy (MCP)',
        mcpServerName: 'server',
      };
      const skill = {
        ...createMockCommand('server:deploy', CommandKind.SKILL),
        pluginName: 'server',
      };
      const builtin = createMockCommand('deploy', CommandKind.BUILT_IN);

      const { finalCommands, conflicts } = SlashCommandResolver.resolve([
        mcp,
        skill,
        builtin,
      ]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('mcp__server__deploy');
      expect(names).toContain('server:deploy');
      expect(names).toContain('deploy');
      expect(finalCommands).toHaveLength(3);
      expect(conflicts).toHaveLength(0);
      expect(
        finalCommands.find((c) => c.name === 'mcp__server__deploy')
          ?.displayName,
      ).toBe('server:deploy (MCP)');
    });

    it('renames source-qualified plugin commands when an exact built-in name wins', () => {
      const command = {
        ...createMockCommand('ecc:doctor', CommandKind.PLUGIN),
        pluginName: 'ecc',
      };
      const builtin = createMockCommand('ecc:doctor', CommandKind.BUILT_IN);

      const { finalCommands, conflicts } = SlashCommandResolver.resolve([
        command,
        builtin,
      ]);

      const names = finalCommands.map((c) => c.name);
      expect(names).toContain('ecc:doctor');
      expect(names).toContain('ecc:doctor1');
      expect(
        finalCommands.find((c) => c.name === 'ecc:doctor')?.kind,
      ).toBe(CommandKind.BUILT_IN);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].losers[0]).toMatchObject({
        command: expect.objectContaining({ kind: CommandKind.PLUGIN }),
        renamedTo: 'ecc:doctor1',
      });
    });
  });
});
