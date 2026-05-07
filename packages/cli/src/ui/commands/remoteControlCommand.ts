/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_REMOTE_CONTROL_PORT } from '../../remoteControl/protocol.js';
import { t } from '../../i18n/index.js';
import {
  CommandKind,
  type MessageActionReturn,
  type RemoteControlCommandServerInfo,
  type RemoteControlCommandStartOptions,
  type SlashCommand,
} from './types.js';

interface ParsedRemoteControlArgs {
  action: 'start' | 'status' | 'stop' | 'help';
  options: RemoteControlCommandStartOptions;
  explicitHost: boolean;
  error?: string;
}

const USAGE = [
  'Usage:',
  '  /remote-control',
  '  /remote-control --allow-lan [--port <port>]',
  '  /remote-control --host <host> [--port <port>]',
  '  /remote-control start [--allow-lan] [--port <port>]',
  '  /remote-control status',
  '  /remote-control stop',
  '',
  'Options:',
  '  --host <host>          Host interface to bind. Defaults to 127.0.0.1.',
  `  --port <port>          Port to listen on. Defaults to ${DEFAULT_REMOTE_CONTROL_PORT}; use 0 for a random free port.`,
  '  --allow-lan            Bind to 0.0.0.0 when --host is omitted and allow LAN access.',
  '  --no-ui                Serve only the remote-control API.',
  '  --token-ttl <seconds>  Pairing token TTL. Defaults to 300 seconds.',
].join('\n');

export const remoteControlCommand: SlashCommand = {
  name: 'remote-control',
  altNames: ['rc'],
  argumentHint: '[status|stop] [--host <host>] [--port <port>] [--allow-lan]',
  get description() {
    return t('Start or inspect browser/mobile remote control for this TUI.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (context, args): Promise<MessageActionReturn> => {
    if (context.executionMode !== 'interactive') {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          '/remote-control is only available in interactive TUI mode.',
        ),
      };
    }

    const remoteControl = context.services.remoteControl;
    if (!remoteControl) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Remote control service is not available.'),
      };
    }

    const parsed = parseRemoteControlArgs(args);
    if (parsed.error) {
      return {
        type: 'message',
        messageType: 'error',
        content: parsed.error,
      };
    }
    if (parsed.action === 'help') {
      return {
        type: 'message',
        messageType: 'info',
        content: USAGE,
      };
    }
    if (parsed.action === 'status') {
      const status = remoteControl.getStatus();
      return {
        type: 'message',
        messageType: 'info',
        content:
          status.running && status.info
            ? formatRemoteControlInfo(status.info, {
                title: 'Remote control is running.',
                reusedToken: true,
              })
            : 'Remote control is not running. Run `/remote-control` to start it.',
      };
    }
    if (parsed.action === 'stop') {
      const stopped = await remoteControl.stop();
      return {
        type: 'message',
        messageType: 'info',
        content: stopped
          ? 'Remote control stopped for the current TUI session.'
          : 'Remote control is not running.',
      };
    }

    const options = {
      ...parsed.options,
      host:
        parsed.options.allowLan && !parsed.explicitHost
          ? '0.0.0.0'
          : parsed.options.host,
    };
    const result = await remoteControl.start(options);
    return {
      type: 'message',
      messageType: 'info',
      content: formatRemoteControlInfo(result.info, {
        title: result.alreadyStarted
          ? 'Remote control is already running for the current TUI session.'
          : 'Remote control attached to the current TUI session.',
        reusedToken: result.alreadyStarted,
      }),
    };
  },
};

function parseRemoteControlArgs(raw: string): ParsedRemoteControlArgs {
  const tokens = raw.trim() ? raw.trim().split(/\s+/) : [];
  const parsed: ParsedRemoteControlArgs = {
    action: 'start',
    options: {},
    explicitHost: false,
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (index === 0 && !token.startsWith('--')) {
      if (token === 'start' || token === 'status' || token === 'stop') {
        parsed.action = token;
        continue;
      }
      if (token === 'help') {
        parsed.action = 'help';
        continue;
      }
      return {
        ...parsed,
        error: `Unknown /remote-control action: ${token}\n\n${USAGE}`,
      };
    }

    if (token === '--help' || token === '-h') {
      parsed.action = 'help';
      continue;
    }
    if (token === '--allow-lan') {
      parsed.options.allowLan = true;
      continue;
    }
    if (token === '--no-ui') {
      parsed.options.noUi = true;
      continue;
    }
    if (token === '--host') {
      const value = tokens[++index];
      if (!value) {
        return {
          ...parsed,
          error: '--host requires a value.',
        };
      }
      parsed.options.host = value;
      parsed.explicitHost = true;
      continue;
    }
    if (token === '--port') {
      const value = tokens[++index];
      const port = parseIntegerFlag('--port', value);
      if (typeof port === 'string') {
        return {
          ...parsed,
          error: port,
        };
      }
      parsed.options.port = port;
      continue;
    }
    if (token === '--token-ttl') {
      const value = tokens[++index];
      const tokenTtlSeconds = parseIntegerFlag('--token-ttl', value);
      if (typeof tokenTtlSeconds === 'string') {
        return {
          ...parsed,
          error: tokenTtlSeconds,
        };
      }
      parsed.options.tokenTtlMs = Math.max(1, tokenTtlSeconds) * 1000;
      continue;
    }

    return {
      ...parsed,
      error: `Unknown /remote-control option: ${token}\n\n${USAGE}`,
    };
  }

  return parsed;
}

function parseIntegerFlag(
  flag: string,
  value: string | undefined,
): number | string {
  if (!value) {
    return `${flag} requires a value.`;
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    return `${flag} must be a non-negative integer.`;
  }
  return numberValue;
}

function formatRemoteControlInfo(
  info: RemoteControlCommandServerInfo,
  options: { title: string; reusedToken: boolean },
): string {
  const lines = [options.title, `URL: ${info.url}`, `WebSocket: ${info.wsUrl}`];
  if (info.lanUrls.length > 0) {
    lines.push('LAN URLs:', ...info.lanUrls.map((url) => `  ${url}`));
  }
  lines.push(
    `Pairing token: ${info.pairingToken}`,
    `Pairing token expires at: ${info.pairingExpiresAt}`,
  );
  if (options.reusedToken) {
    lines.push(
      'Note: the pairing token is one-time. If it was already used, run `/remote-control stop` and then `/remote-control` to generate a fresh token.',
    );
  }
  return lines.join('\n');
}
