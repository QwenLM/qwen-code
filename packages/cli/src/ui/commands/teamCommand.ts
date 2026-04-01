/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import { t } from '../../i18n/index.js';
import {
  listTeams,
  readTeamConfig,
  createTeam,
  stopTeam,
  deleteTeam,
} from '@qwen-code/qwen-code-core';
import { MessageType } from '../types.js';

export const teamCommand: SlashCommand = {
  name: 'team',
  get description() {
    return t('Manage agent teams for coordinated multi-agent work.');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'list',
      get description() {
        return t('List all configured teams.');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context): Promise<void> => {
        const projectDir = context.services.config?.getProjectRoot();
        if (!projectDir) {
          context.ui.addItem(
            { type: MessageType.ERROR, text: 'No project root found.' },
            Date.now(),
          );
          return;
        }

        const teams = await listTeams(projectDir);
        if (teams.length === 0) {
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: 'No teams configured. Use /team start <name> to create one.',
            },
            Date.now(),
          );
        } else {
          const lines = ['## Teams', ''];
          for (const name of teams) {
            const config = await readTeamConfig(projectDir, name);
            if (config) {
              const memberCount = config.members.length;
              const running = config.members.filter(
                (m) => m.status === 'running',
              ).length;
              lines.push(
                `- **${name}** (${config.status}) — ${memberCount} members, ${running} running`,
              );
            }
          }
          context.ui.addItem(
            { type: MessageType.INFO, text: lines.join('\n') },
            Date.now(),
          );
        }
        return;
      },
    },
    {
      name: 'status',
      get description() {
        return t('Show status of a team. Usage: /team status <name>');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context): Promise<void> => {
        const projectDir = context.services.config?.getProjectRoot();
        const teamName = context.invocation?.args?.trim();
        if (!projectDir || !teamName) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: 'Usage: /team status <name>',
            },
            Date.now(),
          );
          return;
        }

        const config = await readTeamConfig(projectDir, teamName);
        if (!config) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Team "${teamName}" not found.`,
            },
            Date.now(),
          );
          return;
        }

        const lines = [
          `## Team: ${config.name}`,
          `Status: ${config.status}`,
          `Created: ${new Date(config.createdAt).toLocaleString()}`,
          '',
          '### Members',
          '',
        ];
        for (const member of config.members) {
          const elapsed = member.startedAt
            ? `${((Date.now() - member.startedAt) / 1000).toFixed(0)}s`
            : '-';
          lines.push(
            `- **${member.name}** (${member.agentType}) — ${member.status} [${elapsed}]`,
          );
        }
        context.ui.addItem(
          { type: MessageType.INFO, text: lines.join('\n') },
          Date.now(),
        );
        return;
      },
    },
    {
      name: 'start',
      get description() {
        return t(
          'Create and start a team. Usage: /team start <name> [member:type ...]',
        );
      },
      kind: CommandKind.BUILT_IN,
      action: async (context): Promise<void> => {
        const projectDir = context.services.config?.getProjectRoot();
        const args = context.invocation?.args?.trim() ?? '';
        const parts = args.split(/\s+/);
        const teamName = parts[0];

        if (!projectDir || !teamName) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: 'Usage: /team start <name> [member:type ...]',
            },
            Date.now(),
          );
          return;
        }

        // Parse member specs: "researcher:Explore implementer:general-purpose"
        const memberSpecs = parts.slice(1).map((spec) => {
          const [name, agentType] = spec.split(':');
          return {
            name: name || spec,
            agentType: agentType || 'general-purpose',
          };
        });

        // Default to a coordinator + explorer if no members specified
        const members =
          memberSpecs.length > 0
            ? memberSpecs
            : [
                { name: 'lead', agentType: 'coordinator' },
                { name: 'scout', agentType: 'Explore' },
              ];

        const config = await createTeam(projectDir, teamName, members);
        const memberList = config.members
          .map((m) => `${m.name} (${m.agentType})`)
          .join(', ');
        context.ui.addItem(
          {
            type: MessageType.SUCCESS,
            text: `Team "${teamName}" created with ${config.members.length} members: ${memberList}`,
          },
          Date.now(),
        );
        return;
      },
    },
    {
      name: 'stop',
      get description() {
        return t('Stop a running team. Usage: /team stop <name>');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context): Promise<void> => {
        const projectDir = context.services.config?.getProjectRoot();
        const teamName = context.invocation?.args?.trim();
        if (!projectDir || !teamName) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: 'Usage: /team stop <name>',
            },
            Date.now(),
          );
          return;
        }

        const config = await stopTeam(projectDir, teamName);
        if (!config) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Team "${teamName}" not found.`,
            },
            Date.now(),
          );
          return;
        }

        context.ui.addItem(
          {
            type: MessageType.SUCCESS,
            text: `Team "${teamName}" stopped.`,
          },
          Date.now(),
        );
        return;
      },
    },
    {
      name: 'delete',
      get description() {
        return t('Delete a team config. Usage: /team delete <name>');
      },
      kind: CommandKind.BUILT_IN,
      action: async (context): Promise<void> => {
        const projectDir = context.services.config?.getProjectRoot();
        const teamName = context.invocation?.args?.trim();
        if (!projectDir || !teamName) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: 'Usage: /team delete <name>',
            },
            Date.now(),
          );
          return;
        }

        const deleted = await deleteTeam(projectDir, teamName);
        context.ui.addItem(
          {
            type: deleted ? MessageType.SUCCESS : MessageType.ERROR,
            text: deleted
              ? `Team "${teamName}" deleted.`
              : `Team "${teamName}" not found.`,
          },
          Date.now(),
        );
        return;
      },
    },
  ],
};
