/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runFileWorker } from './file-worker-runner.js';

process.exitCode = await runFileWorker(process.stdin, (reply) => {
  process.stdout.write(reply);
});
