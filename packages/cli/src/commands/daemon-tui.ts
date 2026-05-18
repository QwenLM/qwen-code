/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type {
  DaemonTuiUpdate,
  DaemonTuiSessionClient,
} from '../ui/daemon/DaemonTuiAdapter.js';
import { createDaemonTuiSession as createDaemonTuiSessionClient } from '../ui/daemon/createDaemonTuiSession.js';

interface DaemonTuiArgs {
  'daemon-url': string;
  token?: string;
  workspace?: string;
  model?: string;
  'session-id'?: string;
  'session-scope'?: 'single' | 'thread';
  prompt?: string;
}

function writeLine(line = ''): void {
  output.write(`${line}\n`);
}

function formatHistoryItem(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return String(item);
  }
  const record = item as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'history';
  const text =
    typeof record['text'] === 'string'
      ? record['text']
      : JSON.stringify(record, null, 2);
  return `[${type}] ${text}`;
}

function printDaemonUpdate(update: DaemonTuiUpdate): void {
  switch (update.type) {
    case 'history':
      writeLine(formatHistoryItem(update.item));
      break;
    case 'tool_group_update':
      writeLine('[tool]');
      for (const tool of update.item.tools) {
        writeLine(`  - ${tool.name}: ${tool.status}`);
        if (tool.resultDisplay !== undefined) {
          writeLine(`    ${JSON.stringify(tool.resultDisplay)}`);
        }
      }
      break;
    case 'permission_request':
      writeLine(`[permission] ${update.requestId}`);
      writeLine(
        `  tool: ${update.request.toolCall.kind} (${update.request.toolCall.toolCallId})`,
      );
      for (const option of update.request.options) {
        writeLine(`  - ${option.optionId}: ${option.name ?? option.optionId}`);
      }
      writeLine(`  approve with: /approve ${update.requestId} <optionId>`);
      writeLine(`  reject with:  /reject ${update.requestId}`);
      break;
    case 'permission_resolved':
      writeLine(
        `[permission_resolved] ${update.requestId} ${JSON.stringify(
          update.outcome,
        )}`,
      );
      break;
    case 'model_switched':
      writeLine(`[model] ${update.modelId}`);
      break;
    case 'disconnected':
      writeLine(`[disconnected] ${update.reason}`);
      break;
    default: {
      const neverUpdate: never = update;
      writeLine(JSON.stringify(neverUpdate));
    }
  }
}

async function createDaemonTuiSession(
  argv: DaemonTuiArgs,
): Promise<DaemonTuiSessionClient> {
  const workspaceCwd = argv.workspace ?? process.cwd();
  return await createDaemonTuiSessionClient({
    daemonUrl: argv['daemon-url'],
    token: argv.token,
    workspaceCwd,
    model: argv.model,
    sessionId: argv['session-id'],
    sessionScope: argv['session-scope'],
  });
}

async function runPrompt(
  session: DaemonTuiSessionClient,
  prompt: string,
): Promise<void> {
  const { DaemonTuiAdapter } = await import('../ui/daemon/DaemonTuiAdapter.js');
  const adapter = new DaemonTuiAdapter({
    session,
    onUpdate: printDaemonUpdate,
  });
  await adapter.start();
  try {
    await adapter.sendPrompt(prompt);
  } finally {
    await adapter.stop();
  }
}

async function runInteractive(session: DaemonTuiSessionClient): Promise<void> {
  const { DaemonTuiAdapter } = await import('../ui/daemon/DaemonTuiAdapter.js');
  const adapter = new DaemonTuiAdapter({
    session,
    onUpdate: printDaemonUpdate,
  });
  await adapter.start();
  const rl = createInterface({ input, output });
  try {
    writeLine(
      `Connected to daemon session ${session.sessionId} (${session.workspaceCwd})`,
    );
    writeLine(
      'Commands: /quit, /cancel, /model <id>, /approve <id> <option>, /reject <id>',
    );
    for (;;) {
      const line = (await rl.question('qwen-daemon> ')).trim();
      if (!line) {
        continue;
      }
      if (line === '/quit' || line === '/exit') {
        return;
      }
      if (line === '/cancel') {
        await adapter.cancel();
        continue;
      }
      if (line.startsWith('/model ')) {
        await adapter.setModel(line.slice('/model '.length).trim());
        continue;
      }
      if (line.startsWith('/approve ')) {
        const [, requestId, optionId] = line.split(/\s+/, 3);
        if (!requestId || !optionId) {
          writeLine('usage: /approve <requestId> <optionId>');
          continue;
        }
        await adapter.approvePermission(requestId, optionId);
        continue;
      }
      if (line.startsWith('/reject ')) {
        const [, requestId] = line.split(/\s+/, 2);
        if (!requestId) {
          writeLine('usage: /reject <requestId>');
          continue;
        }
        await adapter.rejectPermission(requestId);
        continue;
      }
      await adapter.sendPrompt(line);
    }
  } finally {
    rl.close();
    await adapter.stop();
  }
}

export const daemonTuiCommand: CommandModule<unknown, DaemonTuiArgs> = {
  command: 'daemon-tui',
  describe:
    'Experimental local harness for driving the TUI daemon adapter against qwen serve',
  builder: (yargs) =>
    yargs
      .option('daemon-url', {
        type: 'string',
        default: process.env['QWEN_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
        description: 'Base URL of a running qwen serve daemon.',
      })
      .option('token', {
        type: 'string',
        description:
          'Bearer token for the daemon. Defaults to QWEN_SERVER_TOKEN.',
      })
      .option('workspace', {
        type: 'string',
        description:
          'Workspace cwd to pass to POST /session. Defaults to process.cwd().',
      })
      .option('model', {
        type: 'string',
        description: 'Optional model service id for the daemon session.',
      })
      .option('session-id', {
        type: 'string',
        description:
          'Attach to an existing daemon session via POST /session/:id/load.',
      })
      .option('session-scope', {
        type: 'string',
        choices: ['single', 'thread'] as const,
        description:
          'Optional session scope override for new sessions. Omit to use the daemon default.',
      })
      .option('prompt', {
        type: 'string',
        description:
          'Send one prompt and exit. Omit for an interactive validation loop.',
      }),
  handler: async (argv) => {
    try {
      const session = await createDaemonTuiSession(argv);
      if (argv.prompt) {
        await runPrompt(session, argv.prompt);
      } else {
        await runInteractive(session);
      }
    } catch (err) {
      writeStderrLine(
        `qwen daemon-tui: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    process.exit(0);
  },
};
