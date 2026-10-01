#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- Global Entry Point ---

if (
  process.argv.length === 3 &&
  process.argv[2] === '--workspace-recovery-worker'
) {
  void import('./src/serve/workspace-recovery-worker.js').then(
    ({ runWorkspaceRecoveryWorker }) => runWorkspaceRecoveryWorker(),
  );
} else {
  void import('./src/cli.js').then(({ runCliEntryPoint }) =>
    runCliEntryPoint(),
  );
}
