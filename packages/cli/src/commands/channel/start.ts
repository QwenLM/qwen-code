import type { CommandModule } from 'yargs';
import { loadSettings } from '../../config/settings.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { AcpBridge } from '@qwen-code/channel-base';
import type { ChannelConfig } from '@qwen-code/channel-base';
import { TelegramChannel } from '@qwen-code/channel-telegram';
import * as path from 'node:path';

function resolveEnvVars(value: string): string {
  if (value.startsWith('$')) {
    const envName = value.substring(1);
    const envValue = process.env[envName];
    if (!envValue) {
      throw new Error(
        `Environment variable ${envName} is not set (referenced as ${value})`,
      );
    }
    return envValue;
  }
  return value;
}

function findCliEntryPath(): string {
  // When running from bundled dist/cli.js, use that same file for --acp
  const mainModule = process.argv[1];
  if (mainModule) {
    return path.resolve(mainModule);
  }
  throw new Error('Cannot determine CLI entry path');
}

export const startCommand: CommandModule<object, { name: string }> = {
  command: 'start <name>',
  describe: 'Start a messaging channel',
  builder: (yargs) =>
    yargs.positional('name', {
      type: 'string',
      describe: 'Name of the channel (as configured in settings.json)',
      demandOption: true,
    }),
  handler: async (argv) => {
    const { name } = argv;

    const settings = loadSettings(process.cwd());
    const channels = (
      settings.merged as unknown as { channels?: Record<string, unknown> }
    ).channels;

    if (!channels || !channels[name]) {
      writeStderrLine(
        `Error: Channel "${name}" not found in settings. Add it to channels.${name} in settings.json.`,
      );
      process.exit(1);
    }

    const rawConfig = channels[name] as Record<string, unknown>;

    // Validate required fields
    if (!rawConfig['type']) {
      writeStderrLine(
        `Error: Channel "${name}" is missing required field "type".`,
      );
      process.exit(1);
    }
    if (!rawConfig['token']) {
      writeStderrLine(
        `Error: Channel "${name}" is missing required field "token".`,
      );
      process.exit(1);
    }

    const channelType = rawConfig['type'] as string;
    if (channelType !== 'telegram') {
      writeStderrLine(
        `Error: Channel type "${channelType}" is not yet supported. Only "telegram" is available.`,
      );
      process.exit(1);
    }

    let token: string;
    try {
      token = resolveEnvVars(rawConfig['token'] as string);
    } catch (err) {
      writeStderrLine(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    const config: ChannelConfig = {
      type: channelType as ChannelConfig['type'],
      token,
      senderPolicy:
        (rawConfig['senderPolicy'] as ChannelConfig['senderPolicy']) ||
        'allowlist',
      allowedUsers: (rawConfig['allowedUsers'] as string[]) || [],
      sessionScope:
        (rawConfig['sessionScope'] as ChannelConfig['sessionScope']) || 'user',
      cwd: (rawConfig['cwd'] as string) || process.cwd(),
      approvalMode: rawConfig['approvalMode'] as string | undefined,
      instructions: rawConfig['instructions'] as string | undefined,
      groupPolicy:
        (rawConfig['groupPolicy'] as ChannelConfig['groupPolicy']) ||
        'disabled',
      groups: (rawConfig['groups'] as ChannelConfig['groups']) || {},
    };

    const cliEntryPath = findCliEntryPath();
    writeStdoutLine(`[Channel] CLI entry: ${cliEntryPath}`);
    writeStdoutLine(`[Channel] Starting "${name}" (type=${config.type})...`);

    const bridge = new AcpBridge({ cliEntryPath, cwd: config.cwd });
    await bridge.start();

    const channel = new TelegramChannel(name, config, bridge);
    await channel.connect();

    writeStdoutLine(`[Channel] "${name}" is running. Press Ctrl+C to stop.`);

    // Keep process alive until interrupted
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        writeStdoutLine('\n[Channel] Shutting down...');
        channel.disconnect();
        bridge.stop();
        resolve();
      });
      process.on('SIGTERM', () => {
        channel.disconnect();
        bridge.stop();
        resolve();
      });
    });

    process.exit(0);
  },
};
