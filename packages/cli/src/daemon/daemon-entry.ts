/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Entry point for the background daemon process.
 * This file is executed via `fork()` from `qwen daemon start`.
 */

import { DaemonServer } from './server.js';

async function startDaemon(): Promise<void> {
  // Parse port from command line args
  let port = 0;
  const portIdx = process.argv.indexOf('--port');
  if (portIdx !== -1 && process.argv[portIdx + 1]) {
    port = parseInt(process.argv[portIdx + 1], 10) || 0;
  }

  const server = new DaemonServer(process.cwd(), port);
  const info = await server.start();

  // Notify the parent process that we're ready
  if (process.send) {
    process.send({ type: 'ready', port: info.port, authToken: info.authToken });
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  // Handle stop requests from the API
  server.onStop(() => {
    void shutdown();
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startDaemon().catch((err) => {
  process.stderr.write(
    `Daemon startup failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
