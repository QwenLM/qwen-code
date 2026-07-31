import type { CommandModule } from 'yargs';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  loadAccount,
  saveAccount,
  clearAccount,
  DEFAULT_BASE_URL,
} from '@qwen-code/channel-weixin/accounts';
import { startLogin, waitForLogin } from '@qwen-code/channel-weixin/login';

export const configureWeixinCommand: CommandModule<
  object,
  { action: string | undefined }
> = {
  command: 'configure-weixin [action]',
  describe: 'Configure WeChat channel (login via QR code)',
  builder: (yargs) =>
    yargs.positional('action', {
      type: 'string',
      describe: '"clear" to remove stored credentials, omit to login',
    }),
  handler: async (argv) => {
    const { action } = argv;

    if (action === 'clear') {
      clearAccount();
      writeStdoutLine('WeChat credentials cleared.');
      return;
    }

    if (action === 'status') {
      const account = loadAccount();
      if (account) {
        writeStdoutLine(`WeChat account configured (saved ${account.savedAt})`);
        writeStdoutLine(`  Base URL: ${account.baseUrl}`);
        if (account.userId) {
          writeStdoutLine(`  User ID: ${account.userId}`);
        }
      } else {
        writeStdoutLine('WeChat account not configured.');
      }
      return;
    }

    // Default action: login
    const existing = loadAccount();
    if (existing) {
      writeStdoutLine(
        `Existing WeChat credentials found (saved ${existing.savedAt}).`,
      );
      writeStdoutLine('Re-running login will overwrite them.\n');
    }

    const baseUrl = DEFAULT_BASE_URL;

    writeStdoutLine('Starting WeChat QR code login...\n');

    try {
      const qrcodeId = await startLogin(baseUrl);
      const result = await waitForLogin({ qrcodeId, apiBaseUrl: baseUrl });

      if (result.connected && result.token) {
        saveAccount({
          token: result.token,
          baseUrl: result.baseUrl || baseUrl,
          userId: result.userId,
          savedAt: new Date().toISOString(),
        });
        writeStdoutLine('\n' + result.message);
        writeStdoutLine(
          'Credentials saved. You can now start a weixin channel with:',
        );
        writeStdoutLine('  qwen channel start <name>');
      } else {
        writeStderrLine('\n' + result.message);
        process.exit(1);
      }
    } catch (err) {
      writeStderrLine(
        `Login failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  },
};
