/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../utils/stdioHelpers.js';

export const fleetCommand: CommandModule = {
  command: 'fleet',
  describe: 'Open Fleet View to manage active sessions',
  builder: (yargs) => yargs.version(false),
  handler: async () => {
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
