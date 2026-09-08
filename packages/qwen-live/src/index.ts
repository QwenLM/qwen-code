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

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { runInit } from './init.js';
import { LiveDaemon } from './daemon.js';
import { LiveLogger } from './logger.js';
import { parseLiveCliArgs, type LiveCliArgs } from './cli-args.js';
import {
  displayLiveMessage,
  isLiveLanguage,
  liveText,
  type LiveLanguage,
} from './i18n/messages.js';

function preferredLanguage(): LiveLanguage {
  try {
    const configuredDirectory =
      process.env['QWEN_LIVE_DATA_DIR']?.trim() ||
      join(homedir(), '.qwen-live');
    const directory =
      configuredDirectory === '~'
        ? homedir()
        : /^~[/\\]/u.test(configuredDirectory)
          ? join(homedir(), configuredDirectory.slice(2))
          : configuredDirectory;
    const config: unknown = JSON.parse(
      readFileSync(join(directory, 'config.json'), 'utf8').replace(
        /^\uFEFF/u,
        '',
      ),
    );
    if (
      config &&
      typeof config === 'object' &&
      'language' in config &&
      isLiveLanguage(config.language)
    )
      return config.language;
  } catch {
    /* Help remains available when config is missing or invalid. */
  }
  return 'en';
}

export { loadConfig, type BackendConfig, type LiveConfig } from './config.js';
export { LiveDaemon } from './daemon.js';
export { BackendRegistry } from './adaptor/registry.js';
export type {
  BackendAdaptor,
  BackendCapabilities,
  BackendEvent,
  BackendHandle,
} from './adaptor/types.js';

async function main(debug: boolean): Promise<void> {
  const logger = new LiveLogger(debug ? 'debug' : undefined);
  if (debug) {
    logger.debug(
      'diagnostics enabled; media payloads, transcripts, and credentials are omitted',
    );
  }
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
    daemon = new LiveDaemon(loadConfig(), { logger });
  } catch (error) {
    logger.error(
      displayLiveMessage(
        preferredLanguage(),
        error instanceof Error ? error.message : String(error),
      ),
    );
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
    logger.error(
      displayLiveMessage(
        preferredLanguage(),
        error instanceof Error ? error.message : String(error),
      ),
    );
    await daemon.stop().catch(() => undefined);
    process.exitCode = 1;
  }
}

function runCli(args: LiveCliArgs): void {
  if (args.command === 'help') {
    process.stdout.write(`${liveText(preferredLanguage(), 'cli.usage')}\n`);
    return;
  }
  if (args.command === 'init') {
    void runInit().catch((error: unknown) => {
      process.stderr.write(
        `${displayLiveMessage(preferredLanguage(), error instanceof Error ? error.message : String(error))}\n`,
      );
      process.exitCode = 1;
    });
    return;
  }
  void main(args.debug);
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
  try {
    runCli(parseLiveCliArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${displayLiveMessage(preferredLanguage(), error instanceof Error ? error.message : String(error))}\n${liveText(preferredLanguage(), 'cli.usage')}\n`,
    );
    process.exitCode = 1;
  }
}
