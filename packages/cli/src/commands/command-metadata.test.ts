/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { initializeI18n } from '../i18n/index.js';
import { commandMetadata } from './command-metadata.js';

const expected = [
  {
    key: 'mcp',
    command: 'mcp',
    describe: 'Manage MCP servers',
    aliases: [],
  },
  {
    key: 'memory',
    command: 'memory',
    describe: 'Preview and import external memories',
    aliases: [],
  },
  {
    key: 'extensions',
    command: 'extensions <command>',
    describe: 'Manage Qwen Code extensions.',
    aliases: [],
  },
  {
    key: 'auth',
    command: 'auth',
    describe: 'Configure authentication (removed)',
    aliases: [],
  },
  {
    key: 'hooks',
    command: 'hooks',
    describe: 'Manage Qwen Code hooks (use /hooks in interactive mode).',
    aliases: ['hook'],
  },
  {
    key: 'channel',
    command: 'channel',
    describe: 'Manage messaging channels (Telegram, Discord, etc.)',
    aliases: [],
  },
  {
    key: 'board',
    command: 'board',
    describe: 'Share work with other agents through a board',
    aliases: [],
  },
  {
    key: 'serve',
    command: 'serve',
    describe:
      'Run Qwen Code as a local HTTP daemon (Stage 1 experimental: --http-bridge)',
    aliases: [],
  },
  {
    key: 'daemon',
    command: 'daemon',
    describe: 'Inspect and control local qwen serve daemons',
    aliases: [],
  },
  {
    key: 'attach',
    command: 'attach',
    describe: 'Attach a terminal to a running daemon session',
    aliases: [],
  },
  {
    key: 'sessions',
    command: 'sessions',
    describe: 'Manage Qwen Code sessions',
    aliases: [],
  },
  {
    key: 'agents',
    command: 'agents',
    describe: 'Session agents: join a coordinator as a runtime',
    aliases: [],
  },
  {
    key: 'batch',
    command: 'batch',
    describe: 'Run many independent requests through the DashScope Batch API',
    aliases: [],
  },
  {
    key: 'update',
    command: 'update',
    describe: 'Check for Qwen Code updates and install if available',
    aliases: [],
  },
  {
    key: 'sandbox',
    command: 'sandbox [cmd...]',
    describe:
      'Inspect tool confinement, verify it, or run one confined command',
    aliases: [],
  },
];

describe('top-level command metadata contract', () => {
  it('matches all original registrations and keeps update as a getter', async () => {
    await initializeI18n('en');
    const originals = await Promise.all([
      import('./mcp.js').then((module) => module.mcpCommand),
      import('./memory.js').then((module) => module.memoryCommand),
      import('./extensions.js').then((module) => module.extensionsCommand),
      import('./auth.js').then((module) => module.authCommand),
      import('./hooks.js').then((module) => module.hooksCommand),
      import('./channel.js').then((module) => module.channelCommand),
      import('./board.js').then((module) => module.boardCommand),
      import('./serve.js').then((module) => module.serveCommand),
      import('./daemon.js').then((module) => module.daemonCommand),
      import('./attach.js').then((module) => module.attachCommand),
      import('./sessions.js').then((module) => module.sessionsCommand),
      import('./agents.js').then((module) => module.agentsCommand),
      import('./batch.js').then((module) => module.batchCommand),
      import('./update.js').then((module) => module.updateCommand),
      import('./sandbox.js').then((module) => module.sandboxCommand),
    ]);
    expect(Object.keys(commandMetadata)).toEqual(
      expected.map((row) => row.key),
    );
    expect(
      originals.map((command, index) => ({
        key: expected[index].key,
        command: command.command,
        describe: command.describe,
        aliases: command.aliases ?? [],
      })),
    ).toEqual(expected);
    for (const [index, command] of originals.entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(command, 'describe');
      if (expected[index].key === 'update') {
        expect(descriptor?.get).toBeTypeOf('function');
      } else {
        expect(descriptor?.get).toBeUndefined();
        expect(descriptor?.value).toBe(expected[index].describe);
      }
      expect(command).not.toHaveProperty('deprecated');
      expect(command).not.toHaveProperty('middlewares');
    }
  });
});
