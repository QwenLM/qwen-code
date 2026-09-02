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

import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { LiveDaemon } from './daemon.js';
import { LiveLogger } from './logger.js';

export { loadConfig, type BackendConfig, type LiveConfig } from './config.js';
export { LiveDaemon } from './daemon.js';
export { BackendRegistry } from './adaptor/registry.js';
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

// Only run as a daemon when invoked as the bin, not when imported. npm
// installs bins as symlinks and Node resolves import.meta.url through them,
// so compare against the realpath (same pattern as packages/cli/src/cli.ts);
// pathToFileURL also percent-encodes metacharacters (# ? %) the way Node did
// when it formed import.meta.url.
let invokedDirectly = false;
if (process.argv[1] !== undefined) {
  try {
    const entry = realpathSync(process.argv[1]);
    // Direct file invocation…
    invokedDirectly = import.meta.url === pathToFileURL(entry).href;
    // …or directory-form invocation (`node packages/qwen-live`): Node
    // resolves the directory against package.json main; compare against
    // the built entry the bin ships so main() still runs.
    if (
      !invokedDirectly &&
      statSync(entry, { throwIfNoEntry: false })?.isDirectory()
    ) {
      invokedDirectly =
        import.meta.url === pathToFileURL(join(entry, 'dist', 'index.js')).href;
    }
  } catch {
    invokedDirectly = import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}
if (invokedDirectly) {
  void main();
}
