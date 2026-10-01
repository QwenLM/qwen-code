#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- Global Entry Point ---

// Java's private stdio worker bypasses the normal CLI module graph.
const startup =
  process.argv.length === 3 && process.argv[2] === '--workspace-recovery-worker'
    ? import('./src/serve/workspace-recovery-worker.js').then(
        ({ runWorkspaceRecoveryWorker }) => runWorkspaceRecoveryWorker(),
      )
    : import('./src/cli.js').then(({ runCliEntryPoint }) => runCliEntryPoint());

void startup.catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'CLI startup failed.'}\n`,
    () => process.exit(1),
  );
});
