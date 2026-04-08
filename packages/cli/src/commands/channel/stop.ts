import type { CommandModule } from 'yargs';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  readServiceInfo,
  signalService,
  waitForExit,
  removeServiceInfo,
} from './pidfile.js';

export const stopCommand: CommandModule = {
  command: 'stop',
  describe: 'Stop the running channel service',
  handler: async () => {
    const info = readServiceInfo();

    if (!info) {
      writeStdoutLine('No channel service is running.');
      process.exit(0);
    }

    writeStdoutLine(`Stopping channel service (PID ${info.pid})...`);

    if (!signalService(info.pid, 'SIGTERM')) {
      writeStderrLine(
        'Failed to send signal — process may have already exited.',
      );
      removeServiceInfo();
      process.exit(0);
    }

    const exited = await waitForExit(info.pid, 5000);

    if (exited) {
      // Clean up in case the process didn't delete its own PID file
      removeServiceInfo();
      writeStdoutLine('Service stopped.');
    } else {
      writeStderrLine(
        'Service did not exit within 5 seconds. Sending SIGKILL...',
      );
      signalService(info.pid, 'SIGKILL');
      await waitForExit(info.pid, 2000);
      removeServiceInfo();
      writeStdoutLine('Service killed.');
    }

    process.exit(0);
  },
};
