/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 开源 worker runtime 入口：与包根主入口注入同一套依赖，只是换成 worker 形态的基座。
 */

import { runWorkerCli } from './src/worker/workerRuntime.js';

void runWorkerCli();

export { runWorkerCli } from './src/worker/workerRuntime.js';
