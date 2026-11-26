/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAttachmentContext } from './get-attachments.js';
import { getChangedFiles } from './generators/file-generators.js';
import { seedStartupStaticMemoryFileReadState } from './startup-memory-read-state.js';

describe('seedStartupStaticMemoryFileReadState()', () => {
  beforeEach(() => {});

  afterEach(() => {});

  it('seeds startup AGENTS-style memory files into readFileState', () => {
    const ctx = createAttachmentContext('/project', 'session-1');
    const agentsPath = '/project/AGENTS.md';
    const importPath = '/project/docs/context.md';

    const count = seedStartupStaticMemoryFileReadState(ctx, {
      getStaticMemoryFileStates: () => [
        {
          filePath: agentsPath,
          content: 'Use pnpm.\n',
          timestamp: 123,
        },
        {
          filePath: importPath,
          content: 'Imported startup context.\n',
          timestamp: 456,
          isPartialView: true,
        },
      ],
    });

    expect(count).toBe(2);
    expect(ctx.readFileState.get(agentsPath)).toMatchObject({
      content: 'Use pnpm.\n',
      timestamp: 123,
      offset: undefined,
      limit: undefined,
    });
    expect(ctx.readFileState.get(importPath)).toMatchObject({
      content: 'Imported startup context.\n',
      timestamp: 456,
      isPartialView: true,
      offset: undefined,
      limit: undefined,
    });
    expect(ctx.fileReadState.get(agentsPath)).toMatchObject({
      content: 'Use pnpm.\n',
      timestamp: 123,
    });
  });

  it('detects mid-session edits to a startup-loaded AGENTS.md as edited_text_file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-seed-test-'));
    try {
      const ctx = createAttachmentContext(tmpDir, 'session-1');
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      await fs.writeFile(agentsPath, 'Use pnpm.\n');
      const { mtimeMs } = await fs.stat(agentsPath);

      seedStartupStaticMemoryFileReadState(ctx, {
        getStaticMemoryFileStates: () => [
          {
            filePath: agentsPath,
            content: 'Use pnpm.\n',
            timestamp: Math.floor(mtimeMs),
          },
        ],
      });
      expect(await getChangedFiles(ctx)).toEqual([]);

      const later = new Date(mtimeMs + 2000);
      await fs.writeFile(agentsPath, 'Use npm test for core changes.\n');
      await fs.utimes(agentsPath, later, later);

      const changed = await getChangedFiles(ctx);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        type: 'edited_text_file',
        filename: agentsPath,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
