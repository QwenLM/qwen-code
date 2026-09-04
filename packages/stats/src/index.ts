#!/usr/bin/env node
import { exec } from 'node:child_process';

import { parseArgs } from 'node:util';
import { startServer } from './server.js';
import { syncAllSessions } from './sync-worker.js';
import type { TimeRange } from './shared-types.js';
import { getDashboardStats } from './aggregator.js';
import { closeDb } from './db.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '3848' },
    host: { type: 'string', default: '127.0.0.1' },
    'no-open': { type: 'boolean', default: false },
    summary: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    range: { type: 'string', default: '24h' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`
qwen stats — Local observability dashboard for Qwen Code usage statistics

Usage:
  qwen stats [options]

Options:
  --port <port>     Dashboard port (default: 3848)
  --host <host>     Bind address (default: 127.0.0.1)
  --no-open         Don't open browser automatically
  --summary         Print console summary and exit
  --json            Print JSON stats and exit
  --range <range>   Time range: 1h, 24h, 7d, 30d, all (default: 24h)
  -h, --help        Show this help
`);
  process.exit(0);
}

async function main() {
  const port = parseInt(values.port!, 10);

  // Summary / JSON mode: sync, print, exit
  if (values.summary || values.json) {
    console.error('Syncing sessions...');
    await syncAllSessions();

    const stats = getDashboardStats(values.range as TimeRange);

    if (values.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      const o = stats.overview;
      console.log('\n=== Qwen Code Stats ===\n');
      console.log(`  API Requests:    ${o.totalRequests.toLocaleString()} (${o.successfulRequests} ok, ${o.failedRequests} err)`);
      console.log(`  Input Tokens:    ${o.totalInputTokens.toLocaleString()}`);
      console.log(`  Output Tokens:   ${o.totalOutputTokens.toLocaleString()}`);
      console.log(`  Cached Read:     ${o.totalCacheReadTokens.toLocaleString()}`);
      console.log(`  Cache Hit Rate:  ${(o.cacheRate * 100).toFixed(1)}%`);
      console.log(`  Error Rate:      ${(o.errorRate * 100).toFixed(1)}%`);
      console.log(`  Avg Duration:    ${o.avgDuration != null ? `${(o.avgDuration / 1000).toFixed(1)}s` : '—'}`);
      console.log(`  Avg TTFT:        ${o.avgTtft != null ? `${(o.avgTtft / 1000).toFixed(1)}s` : '—'}`);
      console.log(`  Tool Calls:      ${stats.toolStats.totalCalls.toLocaleString()}`);
      console.log(`  Range:           ${values.range}`);
      console.log('');
    }

    closeDb();
    return;
  }

  // Dashboard mode: sync, start server, open browser
  console.error('Syncing sessions...');
  await syncAllSessions();

  const { port: actualPort, stop } = await startServer(port);
  const url = `http://${values.host}:${actualPort}/#/overview?range=${values.range}`;

  console.log(`\n  Qwen Stats dashboard running at ${url}\n`);
  console.log('  Press Ctrl+C to stop.\n');

  if (!values['no-open']) {
    try {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} ${url}`);
    } catch {
      // Browser open is best-effort
    }
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
