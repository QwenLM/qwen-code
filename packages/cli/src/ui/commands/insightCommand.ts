/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';
import { spawn } from 'child_process';
import { join } from 'path';
import os from 'os';
import { registerCleanup } from '../../utils/cleanup.js';
import net from 'net';

// Track the insight server subprocess so we can terminate it on quit
let insightServerProcess: import('child_process').ChildProcess | null = null;

// Find an available port starting from a default port
async function findAvailablePort(startingPort: number = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startingPort;

    const checkPort = () => {
      const server = net.createServer();

      server.listen(port, () => {
        server.once('close', () => {
          resolve(port);
        });
        server.close();
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          port++; // Try next port
          checkPort();
        } else {
          reject(err);
        }
      });
    };

    checkPort();
  });
}

export const insightCommand: SlashCommand = {
  name: 'insight',
  get description() {
    return t(
      'generate personalized programming insights from your chat history',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext) => {
    try {
      context.ui.setDebugMessage(t('Starting insight server...'));

      // If there's an existing insight server process, terminate it first
      if (insightServerProcess && !insightServerProcess.killed) {
        insightServerProcess.kill();
        insightServerProcess = null;
      }

      // Find an available port
      const availablePort = await findAvailablePort(3000);

      const projectsDir = join(os.homedir(), '.qwen', 'projects');

      // Path to the insight server script
      const insightScriptPath = join(
        process.cwd(),
        'packages',
        'cli',
        'src',
        'services',
        'insightServer.ts',
      );

      // Spawn the insight server process
      const serverProcess = spawn('npx', ['tsx', insightScriptPath], {
        stdio: 'pipe',
        env: {
          ...process.env,
          NODE_ENV: 'production',
          BASE_DIR: projectsDir,
          PORT: String(availablePort),
        },
      });

      // Store the server process for cleanup
      insightServerProcess = serverProcess;

      // Register cleanup function to terminate the server process on quit
      registerCleanup(() => {
        if (insightServerProcess && !insightServerProcess.killed) {
          insightServerProcess.kill();
          insightServerProcess = null;
        }
      });

      serverProcess.stderr.on('data', (data) => {
        // Forward error output to parent process stderr
        process.stderr.write(`Insight server error: ${data}`);

        context.ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Insight server error: ${data.toString()}`,
          },
          Date.now(),
        );
      });

      serverProcess.on('close', (code) => {
        console.log(`Insight server process exited with code ${code}`);
        context.ui.setDebugMessage(t('Insight server stopped.'));
        // Reset the reference when the process closes
        if (insightServerProcess === serverProcess) {
          insightServerProcess = null;
        }
      });

      const url = `http://localhost:${availablePort}`;

      // Open browser automatically
      const openBrowser = async () => {
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);

          switch (process.platform) {
            case 'darwin': // macOS
              await execAsync(`open ${url}`);
              break;
            case 'win32': // Windows
              await execAsync(`start ${url}`);
              break;
            default: // Linux and others
              await execAsync(`xdg-open ${url}`);
          }

          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: `Insight server started. Visit: ${url}`,
            },
            Date.now(),
          );
        } catch (err) {
          console.error('Failed to open browser automatically:', err);
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: `Insight server started. Please visit: ${url}`,
            },
            Date.now(),
          );
        }
      };

      // Wait for the server to start (give it some time to bind to the port)
      setTimeout(openBrowser, 1000);

      // Inform the user that the server is running
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t(
            'Insight server started. Check your browser for the visualization.',
          ),
        },
        Date.now(),
      );
    } catch (error) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Failed to start insight server: {{error}}', {
            error: (error as Error).message,
          }),
        },
        Date.now(),
      );
    }
  },
};
