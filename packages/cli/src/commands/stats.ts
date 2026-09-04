/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv, CommandModule } from 'yargs';
import { writeStderrLine } from '../utils/stdioHelpers.js';

interface StatsArgs {
  port?: number;
  summary?: boolean;
  json?: boolean;
}

export const statsCommand: CommandModule<object, StatsArgs> = {
  command: 'stats',
  describe:
    'Open a local dashboard for usage statistics (requests, tokens, costs, models)',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        default: 3847,
        describe: 'Port for the dashboard server',
      })
      .option('summary', {
        type: 'boolean',
        default: false,
        describe: 'Print a console summary and exit',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Print JSON output and exit (implies --summary)',
      }),
  handler: async (argv) => {
    // Dynamic import — stats package pulls in better-sqlite3 + react-dom/server,
    // which we don't want on every `qwen` invocation.
    const { startServer } = await import('@qwen-code/stats/server.js');
    const { syncAllSessions } = await import('@qwen-code/stats/sync-worker.js');
    const { getDashboardStats } = await import('@qwen-code/stats/aggregator.js');
    const { closeDb } = await import('@qwen-code/stats/db.js');

    if (argv.summary || argv.json) {
      await syncAllSessions();
      const stats = getDashboardStats('all');
      if (argv.json) {
        process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
      } else {
        const o = stats.overview;
        writeStderrLine(`Qwen Code Usage Summary (all time)`);
        writeStderrLine(`  Requests: ${o.totalRequests}`);
        writeStderrLine(
          `  Tokens: ${o.totalInputTokens.toLocaleString()} in / ${o.totalOutputTokens.toLocaleString()} out`,
        );
        writeStderrLine(
          `  Cache hit rate: ${(o.cacheHitRate * 100).toFixed(1)}%`,
        );
        writeStderrLine(`  Error rate: ${(o.errorRate * 100).toFixed(1)}%`);
        if (o.avgDuration !== null) {
          writeStderrLine(`  Avg duration: ${o.avgDuration}ms`);
        }
        writeStderrLine(`  Models used: ${stats.byModel.length}`);
        writeStderrLine(`  Projects: ${stats.byFolder.length}`);
      }
      closeDb();
      return;
    }

    const port = argv.port ?? 3847;
    const url = `http://localhost:${port}`;
    writeStderrLine(`Starting Qwen Code stats dashboard at ${url}`);
    writeStderrLine('Press Ctrl+C to stop.');

    const server = await startServer(port);
    void server;

    // Open browser
    try {
      const cmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      const { exec } = await import('node:child_process');
      exec(`${cmd} ${url}`);
    } catch {
      // Browser open is best-effort
    }

    // Keep alive until SIGINT/SIGTERM
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        writeStderrLine('\nShutting down...');
        closeDb();
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  },
};
