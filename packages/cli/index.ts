#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceEntry = /\/index\.[jt]s$/.test(import.meta.url);

function isMainModule(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  if (import.meta.url === pathToFileURL(argvPath).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Private stdio workers bypass the normal CLI module graph.
  if (argv.length === 1 && argv[0] === 'managed-runtime-bootstrap') {
    const { runManagedRuntimeBootstrap } = await import(
      './src/serve/managed-runtime-bootstrap.js'
    );
    return runManagedRuntimeBootstrap();
  }
  if (argv.length === 2 && argv[0] === 'managed-runtime-bootstrap-worker') {
    const { runManagedRuntimeBootstrapWorker } = await import(
      './src/serve/managed-runtime-ssh-worker.js'
    );
    return runManagedRuntimeBootstrapWorker(argv[1]!);
  }
  if (argv.length === 1 && argv[0] === '--workspace-recovery-worker') {
    const { runWorkspaceRecoveryWorker } = await import(
      './src/serve/workspace-recovery-worker.js'
    );
    return runWorkspaceRecoveryWorker();
  }

  const { dispatchCliStartup, runCliEntryPoint } = await import(
    './src/cli-entry.js'
  );
  const entryPath = workspaceEntry
    ? fileURLToPath(new URL('./index.js', import.meta.url))
    : undefined;
  await runCliEntryPoint(
    () => dispatchCliStartup(argv, import.meta.url),
    undefined,
    entryPath,
  );
}

if (workspaceEntry || isMainModule()) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'CLI startup failed.'}\n`,
      () => process.exit(1),
    );
  });
}
