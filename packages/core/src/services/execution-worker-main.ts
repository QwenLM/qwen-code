/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Console } from 'node:console';
import type { ExecutionWorkerOptions } from './execution-environment.js';

globalThis.console = new Console(process.stderr, process.stderr);

try {
  const options: ExecutionWorkerOptions = JSON.parse(process.argv[2] ?? '');
  process.chdir(options.workspace);
  const { createExecutionWorkerEnvironment, runExecutionWorker } = await import(
    './execution-worker.js'
  );
  await runExecutionWorker(
    createExecutionWorkerEnvironment(options),
    process.stdin,
    process.stdout,
  );
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
