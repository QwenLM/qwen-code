#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- Global Entry Point ---

// Java's private stdio worker bypasses the normal CLI module graph.
const startup =
  process.argv.length === 3 && process.argv[2] === 'managed-runtime-bootstrap'
    ? import('./src/serve/managed-runtime-bootstrap.js').then(
        ({ runManagedRuntimeBootstrap }) => runManagedRuntimeBootstrap(),
      )
    : process.argv.length === 4 &&
        process.argv[2] === 'managed-runtime-bootstrap-worker'
      ? import('./src/serve/managed-runtime-ssh-worker.js').then(
          ({ runManagedRuntimeBootstrapWorker }) =>
            runManagedRuntimeBootstrapWorker(process.argv[3]!),
        )
      : process.argv.length === 3 &&
          process.argv[2] === '--workspace-recovery-worker'
        ? import('./src/serve/workspace-recovery-worker.js').then(
            ({ runWorkspaceRecoveryWorker }) => runWorkspaceRecoveryWorker(),
          )
        : import('./src/cli.js').then(({ runCliEntryPoint }) =>
            runCliEntryPoint(),
          );

void startup.catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'CLI startup failed.'}\n`,
    () => process.exit(1),
  );
});
