/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';
import {
  channelStartupFailureBody,
  formatChannelStartupFailures,
  safeChannelCommandErrorMessage,
  sanitizeChannelCommandValue,
} from './startup-failure-format.js';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4170';

interface ChannelSetResultLike {
  changed: boolean;
  replaced: boolean;
  partial: boolean;
  state: {
    transition: string;
    workers: Array<{
      workspaceCwd: string;
      state: string;
      channels: string[];
      pid?: number;
      startupFailures?: unknown;
      startupFailuresTruncated?: unknown;
    }>;
  };
}

interface DaemonClientLike {
  setChannelWorkerSelection(
    selection: { mode: 'all' } | { mode: 'names'; names: string[] },
    opts?: { timeoutMs?: number },
  ): Promise<ChannelSetResultLike>;
}

interface DaemonSdkLike {
  DaemonClient: new (opts: {
    baseUrl: string;
    token?: string;
  }) => DaemonClientLike;
}

interface SetArgs {
  names?: string[];
  'daemon-url'?: string;
  token?: string;
  timeout?: number;
}

export const setCommand: CommandModule<unknown, SetArgs> = {
  command: 'set <names..>',
  describe: 'Set the channel selection for a running qwen serve daemon',
  builder: (yargs) =>
    yargs
      .positional('names', {
        type: 'string',
        array: true,
        demandOption: true,
        describe: 'Channel names, or the single value "all"',
      })
      .option('daemon-url', {
        type: 'string',
        description: `Daemon base URL (default: $${QWEN_DAEMON_URL_ENV} or ${DEFAULT_DAEMON_URL})`,
      })
      .option('token', {
        type: 'string',
        description: `Bearer token (default: $${QWEN_SERVER_TOKEN_ENV} or $${QWEN_DAEMON_TOKEN_ENV})`,
      })
      .option('timeout', {
        type: 'number',
        description: 'Request timeout in milliseconds',
      }),
  handler: async (argv) => {
    const names = [
      ...new Set((argv.names ?? []).map((name) => name.trim())),
    ].filter(Boolean);
    if (names.length === 0 || (names.includes('all') && names.length !== 1)) {
      writeStderrLine(
        '[Channel] Pass one or more channel names, or "all" by itself.',
      );
      process.exit(1);
      return;
    }
    const baseUrl =
      argv['daemon-url'] ||
      process.env[QWEN_DAEMON_URL_ENV] ||
      DEFAULT_DAEMON_URL;
    const token =
      argv.token ??
      process.env[QWEN_SERVER_TOKEN_ENV] ??
      process.env[QWEN_DAEMON_TOKEN_ENV];
    const selection =
      names[0] === 'all'
        ? ({ mode: 'all' } as const)
        : ({ mode: 'names', names } as const);
    let sdk: DaemonSdkLike;
    try {
      sdk = (await import('@qwen-code/sdk/daemon')) as unknown as DaemonSdkLike;
    } catch (error) {
      writeStderrLine(
        `[Channel] Failed to load daemon SDK: ${safeChannelCommandErrorMessage(error)}`,
      );
      process.exit(1);
      return;
    }
    try {
      const client = new sdk.DaemonClient({
        baseUrl,
        ...(token ? { token } : {}),
      });
      const result = await client.setChannelWorkerSelection(
        selection,
        argv.timeout !== undefined ? { timeoutMs: argv.timeout } : undefined,
      );
      const workers = result.state.workers
        .map(
          (worker) =>
            `${worker.workspaceCwd}:${worker.channels.join(',') || 'none'}`,
        )
        .join('; ');
      writeStdoutLine(
        `[Channel] Selection ${result.changed ? 'applied' : 'unchanged'} ` +
          `(replaced=${result.replaced}, partial=${result.partial}, workers=${workers || 'none'}).`,
      );
      for (const worker of result.state.workers) {
        for (const line of formatChannelStartupFailures(
          worker,
          worker.workspaceCwd,
        )) {
          writeStdoutLine(line);
        }
      }
      process.exit(0);
    } catch (error) {
      const safeBaseUrl = sanitizeChannelCommandValue(baseUrl, 2048);
      writeStderrLine(
        `[Channel] Set failed (${safeBaseUrl}): ${safeChannelCommandErrorMessage(error)}`,
      );
      for (const line of formatChannelStartupFailures(
        channelStartupFailureBody(error),
      )) {
        writeStderrLine(line);
      }
      process.exit(1);
    }
  },
};
