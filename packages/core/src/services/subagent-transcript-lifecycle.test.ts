/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSessionTranscriptPath } from './transcript-paths.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { UserMessage } from '../protocol/transcript/message.js';
import {
  nodeTranscriptFileSystem,
  type TranscriptFileSystem,
} from './transcript/append-channel.js';
import type { TranscriptPathFileSystem } from './transcript/paths.js';
import { TranscriptStore } from './transcript/store.js';
import { createSubagentTranscriptRecorder } from './subagent-transcript.js';
import { setConfigHomeDirOverride } from '../utils/paths.js';

const tempDirs: string[] = [];

afterEach(async () => {
  setConfigHomeDirOverride(undefined);
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: transcript access failed`), {
    code,
  });
}

describe('subagent transcript recorder lifecycle', () => {
  it('evicts a failed writer and creates a fresh channel after access is restored', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subagent-transcript-lifecycle-'),
    );
    tempDirs.push(root);
    setConfigHomeDirOverride(root);
    let accessDenied = true;
    const fileSystem: TranscriptFileSystem & TranscriptPathFileSystem = {
      ...nodeTranscriptFileSystem,
      realpath: (targetPath) => fs.realpath(targetPath),
      appendFile: async (targetPath, data, options) => {
        if (accessDenied) {
          throw errnoError('EACCES');
        }
        await nodeTranscriptFileSystem.appendFile(targetPath, data, options);
      },
    };
    const store = new TranscriptStore({
      stateSource: {
        loadSessionWriterState: async () => ({ messageUuids: [] }),
      },
      coordinatorOptions: { fileSystem, flushIntervalMs: 0 },
    });
    const config = {
      getTranscriptStore: () => store,
      getProjectRoot: () => root,
      getSessionArtifactProjectRoot: () => root,
      getActiveSessionTranscriptPath(this: Config): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getSessionId: () => 'session-1',
      getTargetDir: () => root,
    } as unknown as Config;
    const message: UserMessage = {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000001',
      timestamp: '2026-08-12T00:00:00.000Z',
      message: { role: 'user', content: 'inspect the repository' },
    };
    const onUnavailable = vi.fn();
    const failedRecorder = await createSubagentTranscriptRecorder(
      config,
      'agent-1',
      'task-1',
      onUnavailable,
    );

    await expect(
      failedRecorder.recordSidechainMessages([message], 'agent-1'),
    ).resolves.toBeNull();
    await expect(failedRecorder.close()).resolves.toBeUndefined();
    expect(onUnavailable).toHaveBeenCalledOnce();

    accessDenied = false;
    const recoveredRecorder = await createSubagentTranscriptRecorder(
      config,
      'agent-1',
      'task-2',
      vi.fn(),
    );
    await expect(
      recoveredRecorder.recordSidechainMessages([message], 'agent-1'),
    ).resolves.toBe(message.uuid);
    await expect(recoveredRecorder.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
