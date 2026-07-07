/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../utils/stdioHelpers.js';

interface FleetArgs {
  'daemon-url'?: string;
  token?: string;
}

export const fleetCommand: CommandModule<unknown, FleetArgs> = {
  command: 'fleet',
  describe: 'Open Fleet View to manage active sessions',
  builder: (yargs) =>
    yargs
      .option('daemon-url', {
        type: 'string',
        description: 'Daemon URL to connect to (default: auto-discover)',
      })
      .option('token', {
        type: 'string',
        description: 'Daemon authentication token',
      })
      .version(false),
  handler: async (_argv) => {
    const { showStandaloneFleetView } = await import(
      '../ui/components/fleet-view/StandaloneFleetView.js'
    );

    const cwd = process.cwd();
    const selectedSessionId = await showStandaloneFleetView(cwd);

    if (selectedSessionId) {
      writeStdoutLine(`Selected session: ${selectedSessionId}`);
      writeStdoutLine(`Run: qwen-code --resume ${selectedSessionId}`);
    }
    process.exit(0);
  },
};
