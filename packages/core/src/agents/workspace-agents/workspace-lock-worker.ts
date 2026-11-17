/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage } from '../../config/storage.js';
import { generateAgentId, updateWorkspaceAgents } from './store.js';

const runtimeDir = process.env['AGENT_LOCK_RUNTIME_DIR'];
const projectRoot = process.env['AGENT_LOCK_PROJECT_ROOT'];
const tag = process.env['AGENT_LOCK_TAG'];
const count = Number(process.env['AGENT_LOCK_COUNT']);
if (
  !runtimeDir ||
  !projectRoot ||
  !tag ||
  !Number.isInteger(count) ||
  count < 1
) {
  throw new Error('Invalid workspace lock worker environment.');
}

Storage.setRuntimeBaseDir(runtimeDir);
const added: string[] = [];
for (let index = 0; index < count; index += 1) {
  const name = `${tag}-${index}`;
  // A read-modify-write of the whole roster: without the cross-process lock,
  // the other worker's append in between would be lost.
  await updateWorkspaceAgents(projectRoot, (agents) => [
    ...agents,
    { id: generateAgentId(), name, createdAt: Date.now() },
  ]);
  added.push(name);
}
process.stdout.write(JSON.stringify(added));
