import type { CommandModule } from 'yargs';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4170';

// Structural subset of the SDK's DaemonChannelReloadResult. Kept local (like
// daemon-worker.ts's DaemonSdkLike) so this command doesn't take a static
// type dependency on the SDK subpath.
interface ChannelReloadResultLike {
  reloaded: boolean;
  worker: {
    state: string;
    channels: string[];
    pid?: number;
    restartCount?: number;
    error?: string;
  };
}

interface DaemonClientLike {
  reloadChannelWorker(opts?: {
    clientId?: string;
    timeoutMs?: number;
  }): Promise<ChannelReloadResultLike>;
}

interface DaemonSdkLike {
  DaemonClient: new (opts: {
    baseUrl: string;
    token?: string;
  }) => DaemonClientLike;
}

interface ReloadArgs {
  'daemon-url'?: string;
  token?: string;
  timeout?: number;
}

function resolveDaemonUrl(flag: string | undefined): string {
  // `||` (not `??`) so an empty flag or empty env var falls through to the
  // default rather than producing an unusable empty base URL.
  return flag || process.env[QWEN_DAEMON_URL_ENV] || DEFAULT_DAEMON_URL;
}

function resolveToken(flag: string | undefined): string | undefined {
  return (
    flag ??
    process.env[QWEN_SERVER_TOKEN_ENV] ??
    process.env[QWEN_DAEMON_TOKEN_ENV]
  );
}

export const reloadCommand: CommandModule<unknown, ReloadArgs> = {
  command: 'reload',
  describe:
    'Reload the daemon-managed channel worker so it re-reads settings.json',
  builder: (yargs) =>
    yargs
      .option('daemon-url', {
        type: 'string',
        description: `Daemon base URL (default: $${QWEN_DAEMON_URL_ENV} or ${DEFAULT_DAEMON_URL})`,
      })
      .option('token', {
        type: 'string',
        description: `Bearer token (default: $${QWEN_SERVER_TOKEN_ENV})`,
      })
      .option('timeout', {
        type: 'number',
        description: 'Request timeout in milliseconds',
      }),
  handler: async (argv) => {
    const baseUrl = resolveDaemonUrl(argv['daemon-url']);
    const token = resolveToken(argv.token);

    let sdk: DaemonSdkLike;
    try {
      sdk = (await import('@qwen-code/sdk/daemon')) as unknown as DaemonSdkLike;
    } catch (err) {
      writeStderrLine(
        `[Channel] Failed to load daemon SDK: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(1);
    }

    const client = new sdk.DaemonClient({
      baseUrl,
      ...(token ? { token } : {}),
    });

    try {
      const result = await client.reloadChannelWorker(
        argv.timeout !== undefined ? { timeoutMs: argv.timeout } : undefined,
      );
      const worker = result.worker;
      const parts = [
        `state=${worker.state}`,
        `channels=${worker.channels.join(', ') || 'none'}`,
        ...(worker.pid !== undefined ? [`pid=${worker.pid}`] : []),
        ...(worker.restartCount !== undefined
          ? [`restarts=${worker.restartCount}`]
          : []),
        ...(worker.error ? [`error=${worker.error}`] : []),
      ];
      writeStdoutLine(`[Channel] Reloaded (${parts.join(', ')}).`);
      process.exit(0);
    } catch (err) {
      writeStderrLine(
        `[Channel] Reload failed (${baseUrl}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(1);
    }
  },
};
