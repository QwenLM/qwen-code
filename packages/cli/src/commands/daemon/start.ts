/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { readLockFile, isDaemonRunning } from '../../daemon/lock-file.js';

export const startCommand: CommandModule = {
  command: 'start',
  describe: 'Start the Qwen Code daemon',
  builder: (yargs) =>
    yargs
      .option('port', {
        type: 'number',
        describe: 'Port to listen on (default: auto-assign)',
        default: 0,
      })
      .option('foreground', {
        type: 'boolean',
        describe: 'Run in the foreground instead of as a background process',
        default: false,
      }),
  handler: async (argv) => {
    const port = argv['port'] as number;
    const foreground = argv['foreground'] as boolean;

    // Check if daemon is already running
    const existingLock = readLockFile();
    if (existingLock && isDaemonRunning(existingLock)) {
      writeStdoutLine(
        `Daemon is already running (PID: ${existingLock.pid}, port: ${existingLock.port})`,
      );
      writeStdoutLine(
        `Access at: http://127.0.0.1:${existingLock.port}/?token=${existingLock.authToken}`,
      );
      return;
    }

    if (foreground) {
      // Run in foreground - import and start server directly
      const { DaemonServer } = await import('../../daemon/server.js');
      const server = new DaemonServer(process.cwd(), port);
      const info = await server.start();

      writeStdoutLine(`Qwen Code daemon started (PID: ${process.pid})`);
      writeStdoutLine(`Listening on: http://127.0.0.1:${info.port}`);
      writeStdoutLine(
        `Access URL: http://127.0.0.1:${info.port}/?token=${info.authToken}`,
      );
      writeStdoutLine('\nPress Ctrl+C to stop.');

      // Keep running until interrupted
      const shutdown = async () => {
        writeStdoutLine('\nShutting down daemon...');
        await server.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep the event loop alive
      await new Promise(() => {});
    } else {
      // Fork a background process running the daemon entry point
      const currentFile = fileURLToPath(import.meta.url);
      const daemonEntry = path.resolve(
        path.dirname(currentFile),
        '../../daemon/daemon-entry.js',
      );

      const child = fork(daemonEntry, ['--port', String(port)], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        cwd: process.cwd(),
        env: { ...process.env },
      });

      // Wait for the child to report it's ready
      const result = await new Promise<{
        port: number;
        authToken: string;
        pid: number;
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Daemon startup timed out'));
          child.kill();
        }, 10000);

        child.on('message', (msg: unknown) => {
          clearTimeout(timeout);
          const m = msg as { type: string; port: number; authToken: string };
          if (m.type === 'ready') {
            resolve({
              port: m.port,
              authToken: m.authToken,
              pid: child.pid!,
            });
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        child.on('exit', (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`Daemon process exited with code ${code}`));
          }
        });
      });

      // Detach the child so it can run independently
      child.unref();
      child.disconnect();

      writeStdoutLine(`Qwen Code daemon started (PID: ${result.pid})`);
      writeStdoutLine(
        `Access URL: http://127.0.0.1:${result.port}/?token=${result.authToken}`,
      );
    }
  },
};
