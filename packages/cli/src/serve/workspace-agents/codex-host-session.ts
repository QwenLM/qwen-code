/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export async function codexHostSession(directory: string, scope: string[]) {
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const file = path.join(directory, `${key}.json`);
  let threadId: string | undefined;
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      saved.schemaVersion !== 1 ||
      JSON.stringify(saved.scope) !== JSON.stringify(scope) ||
      typeof saved.threadId !== 'string' ||
      !saved.threadId.trim()
    ) {
      throw new Error('Invalid saved Codex session; refusing to replace it.');
    }
    threadId = saved.threadId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    get threadId() {
      return threadId;
    },
    async save(id: string) {
      if (threadId === id) return;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(
        temporary,
        JSON.stringify({ schemaVersion: 1, scope, threadId: id }),
        { mode: 0o600, flag: 'wx' },
      );
      await fs.rename(temporary, file);
      threadId = id;
    },
  };
}
