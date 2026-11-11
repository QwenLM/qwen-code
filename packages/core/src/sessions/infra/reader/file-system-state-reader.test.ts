/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSystemSessionWriterStateReader } from './file-system-state-reader.js';

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'test-state-test-'));
}

describe('FileSystemSessionWriterStateReader', () => {
  it('returns empty state for a missing file', async () => {
    const reader = new FileSystemSessionWriterStateReader();
    const state = await reader.load('/nonexistent/file.jsonl', 's1');
    expect(state.messageUuids).toEqual([]);
  });

  it('collects message uuids and metadata from a transcript', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 's1.jsonl');

    await fs.writeFile(
      filePath,
      [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', parentUuid: 'u1', isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} }),
        JSON.stringify({ type: 'custom-title', sessionId: 's1', customTitle: 'My Title' }),
        JSON.stringify({ type: 'last-prompt', sessionId: 's1', lastPrompt: 'hello' }),
        JSON.stringify({ type: 'tag', sessionId: 's1', tag: 'todo' }),
        JSON.stringify({ type: 'workspace-directories', sessionId: 's1', directories: ['/a', '/b'] }),
        JSON.stringify({ type: 'active-leaf', sessionId: 's1', leafUuid: 'a1', explicit: true, timestamp: 1 }),
      ].join('\n') + '\n',
    );

    const reader = new FileSystemSessionWriterStateReader();
    const state = await reader.load(filePath, 's1');

    expect(state.messageUuids).toEqual(['u1', 'a1']);
    expect(state.mainParentUuid).toBe('a1');
    expect(state.activeLeafUuid).toBe('a1');
    expect(state.customTitle).toBe('My Title');
    expect(state.lastPrompt).toBe('hello');
    expect(state.tag).toBe('todo');
    expect(state.workspaceDirectories).toEqual(['/a', '/b']);
  });
});
