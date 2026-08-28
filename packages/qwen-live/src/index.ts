#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen-live` bin entry: load config, start the daemon, exit cleanly on
 * SIGINT/SIGTERM.
 */

import { loadConfig } from './config.js';
import { LiveDaemon } from './daemon.js';
import { LiveLogger } from './logger.js';

export { loadConfig, type LiveConfig } from './config.js';
export { LiveDaemon } from './daemon.js';
export type {
  BackendAdaptor,
  BackendCapabilities,
  BackendEvent,
  BackendHandle,
} from './adaptor/types.js';

async function main(): Promise<void> {
  const logger = new LiveLogger();
  // A stray rejection in a background chain (event pump, auto-approval)
  // must be diagnosable, not process-fatal.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `unhandled rejection: ${
        reason instanceof Error
          ? (reason.stack ?? reason.message)
          : String(reason)
      }`,
    );
  });
  let daemon: LiveDaemon;
  try {
    daemon = new LiveDaemon(loadConfig());
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    daemon
      .stop()
      .catch((error: unknown) => {
        logger.error(
          `shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  try {
    await daemon.start();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    await daemon.stop().catch(() => undefined);
    process.exitCode = 1;
  }
}

// Only run as a daemon when invoked as the bin, not when imported.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  void main();
}
