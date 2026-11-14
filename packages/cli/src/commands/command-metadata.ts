/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const commandMetadata = {
  mcp: {
    command: 'mcp',
    describe: 'Manage MCP servers',
  },
  memory: {
    command: 'memory',
    describe: 'Preview and import external memories',
  },
  extensions: {
    command: 'extensions <command>',
    describe: 'Manage Qwen Code extensions.',
  },
  auth: {
    command: 'auth',
    describe: 'Configure authentication (removed)',
  },
  hooks: {
    command: 'hooks',
    aliases: ['hook'],
    describe: 'Manage Qwen Code hooks (use /hooks in interactive mode).',
  },
  channel: {
    command: 'channel',
    describe: 'Manage messaging channels (Telegram, Discord, etc.)',
  },
  board: {
    command: 'board',
    describe: 'Share work with other agents through a board',
  },
  serve: {
    command: 'serve',
    describe:
      'Run Qwen Code as a local HTTP daemon (Stage 1 experimental: --http-bridge)',
  },
  daemon: {
    command: 'daemon',
    describe: 'Inspect and control local qwen serve daemons',
  },
  attach: {
    command: 'attach',
    describe: 'Attach a terminal to a running daemon session',
  },
  sessions: {
    command: 'sessions',
    describe: 'Manage Qwen Code sessions',
  },
  agents: {
    command: 'agents',
    describe: 'Session agents: join a coordinator as a runtime',
  },
  batch: {
    command: 'batch',
    describe: 'Run many independent requests through the DashScope Batch API',
  },
  update: {
    command: 'update',
    describe: 'Check for Qwen Code updates and install if available',
  },
  sandbox: {
    command: 'sandbox [cmd...]',
    describe:
      'Inspect tool confinement, verify it, or run one confined command',
  },
} as const;
