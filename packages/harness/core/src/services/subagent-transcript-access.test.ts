/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSessionTranscriptPath } from './transcript-paths.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import {
  createSubagentTranscriptRecorder,
  loadAllSubagentTranscripts,
  readSubagentTranscript,
  readSubagentMetadata,
} from './subagent-transcript.js';
import type { Config } from '../config/config.js';
import type { TranscriptRepository } from './transcript/repository.js';
import type { TranscriptWriterHandle } from './transcript/writer-handle.js';

const warnMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    warn: warnMock,
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => '{}'),
  readdir: vi.fn(async () => []),
  rm: vi.fn(async () => undefined),
}));

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: file access failed`), { code });
}

describe('subagent transcript access failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats metadata denied by the operating system as unavailable', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(errnoError('EPERM'));

    await expect(
      readSubagentMetadata('/workspace/project', 'session-1', 'agent-1'),
    ).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith(
      '[SubagentRun] persistence unavailable',
      'operation=read-metadata',
      expect.stringContaining('agent-agent-1.meta.json'),
      expect.objectContaining({ code: 'EPERM' }),
    );
  });

  it('returns no history when the transcript directory cannot be listed', async () => {
    vi.mocked(fs.readdir).mockRejectedValueOnce(errnoError('EACCES'));

    await expect(
      loadAllSubagentTranscripts('/workspace/project', 'session-1'),
    ).resolves.toEqual([]);
    expect(warnMock).toHaveBeenCalledWith(
      '[SubagentRun] persistence unavailable',
      'operation=list',
      expect.stringContaining('subagents'),
      expect.objectContaining({ code: 'EACCES' }),
    );
  });

  it('does not hide unrelated metadata read failures', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(errnoError('EIO'));

    await expect(
      readSubagentMetadata('/workspace/project', 'session-1', 'agent-1'),
    ).rejects.toThrow('EIO');
  });

  it('treats a denied transcript file as unavailable', async () => {
    const repository = {
      resolveSession: vi.fn(async () => {
        throw errnoError('EPERM');
      }),
    } as unknown as TranscriptRepository;

    await expect(
      readSubagentTranscript(
        '/workspace/project',
        'session-1',
        'agent-1',
        repository,
      ),
    ).resolves.toBeNull();
    expect(warnMock).toHaveBeenCalledWith(
      '[SubagentRun] persistence unavailable',
      'operation=read',
      expect.stringContaining('agent-agent-1.jsonl'),
      expect.objectContaining({ code: 'EPERM' }),
    );
  });

  it('does not hide unrelated transcript read failures', async () => {
    const repository = {
      resolveSession: vi.fn(async () => {
        throw errnoError('EIO');
      }),
    } as unknown as TranscriptRepository;

    await expect(
      readSubagentTranscript(
        '/workspace/project',
        'session-1',
        'agent-1',
        repository,
      ),
    ).rejects.toThrow('EIO');
  });

  it('disables delayed transcript writes after an access failure', async () => {
    const rawWriter = {
      filePath: '/workspace/project/session-1/subagents/agent-agent-1.jsonl',
      recordSidechainMessages: vi
        .fn()
        .mockRejectedValueOnce(errnoError('EACCES')),
      close: vi.fn(async () => undefined),
    } as unknown as TranscriptWriterHandle;
    const onUnavailable = vi.fn();
    const config = {
      getTranscriptStore: () => ({
        acquireSubagentWriter: vi.fn(async () => rawWriter),
      }),
      getProjectRoot: () => '/workspace/project',
      getSessionArtifactProjectRoot: () => '/workspace/project',
      getActiveSessionTranscriptPath(this: Config): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getSessionId: () => 'session-1',
      getTargetDir: () => '/workspace/project',
    } as unknown as Config;
    const recorder = await createSubagentTranscriptRecorder(
      config,
      'agent-1',
      'task-1',
      onUnavailable,
    );

    await expect(
      recorder.recordSidechainMessages([], 'agent-1', 'parent-1'),
    ).resolves.toBe('parent-1');
    await expect(
      recorder.recordSidechainMessages([], 'agent-1', 'parent-1'),
    ).resolves.toBe('parent-1');

    expect(rawWriter.recordSidechainMessages).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('surfaces unrelated delayed write and close failures', async () => {
    const rawWriter = {
      filePath: '/workspace/project/session-1/subagents/agent-agent-1.jsonl',
      recordSidechainMessages: vi.fn().mockRejectedValue(errnoError('EIO')),
      close: vi.fn().mockRejectedValue(errnoError('EIO')),
    } as unknown as TranscriptWriterHandle;
    const config = {
      getTranscriptStore: () => ({
        acquireSubagentWriter: vi.fn(async () => rawWriter),
      }),
      getProjectRoot: () => '/workspace/project',
      getSessionArtifactProjectRoot: () => '/workspace/project',
      getActiveSessionTranscriptPath(this: Config): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getSessionId: () => 'session-1',
      getTargetDir: () => '/workspace/project',
    } as unknown as Config;
    const recorder = await createSubagentTranscriptRecorder(
      config,
      'agent-1',
      'task-1',
      vi.fn(),
    );

    await expect(
      recorder.recordSidechainMessages([], 'agent-1'),
    ).rejects.toThrow('EIO');
    await expect(recorder.close()).rejects.toThrow('EIO');
  });
});
