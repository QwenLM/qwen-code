/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage } from '../../config/storage.js';
import { allocateRunSequence } from './store.js';

const runtimeDir = process.env['AGENT_LOCK_RUNTIME_DIR'];
const projectRoot = process.env['AGENT_LOCK_PROJECT_ROOT'];
const count = Number(process.env['AGENT_LOCK_COUNT']);
if (!runtimeDir || !projectRoot || !Number.isInteger(count) || count < 1) {
  throw new Error('Invalid workspace lock worker environment.');
}

Storage.setRuntimeBaseDir(runtimeDir);
const sequences: number[] = [];
for (let index = 0; index < count; index += 1) {
  sequences.push(await allocateRunSequence(projectRoot));
}
process.stdout.write(JSON.stringify(sequences));
