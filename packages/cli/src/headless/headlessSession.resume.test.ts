/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  beginResumeRead,
  getSessionTranscriptPath,
  getSessionStatePath,
  resolveFileCheckpointRoot,
  Storage,
  runLogger,
  type ResumeTranscriptResult,
} from '@qwen-code/core';
import {
  HeadlessSession,
  type HeadlessSessionParams,
} from './headlessSession.js';
import { resolveHeadlessResume } from './sessionResume.js';

vi.mock('./startup.js', () => ({ prepareHeadlessSession: vi.fn() }));

vi.mock('./sessionResume.js', () => ({ resolveHeadlessResume: vi.fn() }));

it('hands the bounded candidate to Manager and releases admission when open fails', async () => {
  const attempt = await beginResumeRead();
  const candidate = { sessionId: 'source', attempt } as ResumeTranscriptResult;
  vi.mocked(resolveHeadlessResume).mockResolvedValue({
    sessionId: 'source',
    sessionPath: '/tmp/source.jsonl',
    messages: [],
    resumeAttempt: attempt,
    resumeCandidate: candidate,
  });
  const open = vi.fn().mockRejectedValue(new Error('open failed'));
  const session = new HeadlessSession({
    cliArgs: { resume: '  source  ', outputFormat: 'text' },
    settings: { merged: {} },
    workspaceRoot: '/tmp',
    threadManager: { open },
  } as unknown as HeadlessSessionParams);
  try {
    await expect(
      (session as unknown as { openSession(): Promise<void> }).openSession(),
    ).rejects.toThrow('open failed');
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'source',
        resumeCandidate: candidate,
        cliArgs: expect.objectContaining({ resume: 'source' }),
      }),
    );
    expect(attempt.signal.aborted).toBe(true);
    const next = await beginResumeRead({ limits: { timeoutMs: 100 } });
    next.finish();
  } finally {
    attempt.finish();
  }
});

it.each(['open', 'afterResponse', 'shutdown', 'success'])(
  'owns precreated fork artifacts until startup succeeds (%s)',
  async (stage) => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-owner-'));
    const warnings = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    const storage = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(path.join(projectRoot, '.config'));
    const target = getSessionTranscriptPath(projectRoot, 'target');
    const state = getSessionStatePath(projectRoot, 'target');
    const checkpoint = path.join(resolveFileCheckpointRoot(), 'target', 'blob');
    for (const file of [state, checkpoint]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'fork artifact');
    }
    const source = getSessionTranscriptPath(projectRoot, 'source');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'fork');
    await fs.writeFile(source, 'source');
    const resumeState = { sessionId: 'target', filePath: target } as never;
    const entries = [{ type: 'custom-title', customTitle: 'Fork' }] as never;
    vi.mocked(resolveHeadlessResume).mockResolvedValue({
      transcriptReadState: resumeState,
      forkTranscriptEntries: entries,
      sessionId: 'target',
      sourceSessionId: 'source',
      sourceSessionPath: source,
      messages: [],
      forkTranscriptPath: target,
      sessionPath: target,
      transcriptProjectRoot: projectRoot,
    });
    const failure = new Error(`${stage} failed`);
    const manager = {
      open: vi.fn().mockImplementation(async () => {
        if (stage === 'open') throw failure;
        return 'target';
      }),
      requireSession: () => ({ signal: new AbortController().signal }),
      initialize: vi.fn().mockImplementation(async () => {
        if (stage === 'shutdown') throw failure;
        return {
          afterResponseSent: async () => {
            if (stage === 'afterResponse') throw failure;
          },
        };
      }),
      close: vi.fn().mockImplementation(async () => {
        if (stage === 'shutdown') throw failure;
      }),
      shutdown: vi.fn().mockImplementation(async () => {
        if (stage === 'shutdown') throw failure;
      }),
    };
    const session = new HeadlessSession({
      cliArgs: { resume: 'source', forkSession: true, outputFormat: 'text' },
      settings: { merged: {} },
      workspaceRoot: projectRoot,
      threadManager: manager,
    } as unknown as HeadlessSessionParams);
    const lifecycle = session as unknown as {
      openSession(): Promise<void>;
      initializeSession(): Promise<void>;
      finish(): Promise<void>;
      applyResumeAndWorktreeState(): Promise<void>;
      currentConfig(): unknown;
    };
    vi.spyOn(lifecycle, 'applyResumeAndWorktreeState').mockResolvedValue();
    vi.spyOn(lifecycle, 'currentConfig').mockReturnValue({
      getEffectiveQuestion: () => '',
      getSessionPersistence: () => true,
    });
    try {
      if (stage === 'success') {
        await lifecycle.openSession();
        await lifecycle.initializeSession();
      } else {
        await expect(
          (async () => {
            await lifecycle.openSession();
            await lifecycle.initializeSession();
          })(),
        ).rejects.toThrow(failure.message);
      }
      expect(manager.open).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'target',
          forked: true,
          resumeData: expect.objectContaining({
            resumeState,
            forkTranscriptEntries: entries,
            sourceSessionId: 'source',
          }),
        }),
      );
      await lifecycle.finish();
      expect(await fs.readFile(source, 'utf8')).toBe('source');
      for (const artifact of [target, state, checkpoint]) {
        if (stage === 'success' || stage === 'shutdown')
          await expect(fs.access(artifact)).resolves.toBeUndefined();
        else await expect(fs.access(artifact)).rejects.toThrow();
      }
    } finally {
      warnings.mockRestore();
      storage.mockRestore();
      await fs.rm(path.dirname(target), { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  },
);

it('leaves conflicting preexisting artifacts intact when fork creation rejects', async () => {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'fork-conflict-'),
  );
  const target = path.join(projectRoot, 'existing.jsonl');
  await fs.writeFile(target, 'existing');
  vi.mocked(resolveHeadlessResume).mockRejectedValue(
    new Error('target already exists'),
  );
  const manager = { open: vi.fn(), shutdown: vi.fn() };
  const session = new HeadlessSession({
    cliArgs: { resume: 'source', forkSession: true, outputFormat: 'text' },
    settings: { merged: {} },
    workspaceRoot: projectRoot,
    threadManager: manager,
  } as unknown as HeadlessSessionParams);
  const lifecycle = session as unknown as {
    openSession(): Promise<void>;
    finish(): Promise<void>;
  };
  try {
    await expect(lifecycle.openSession()).rejects.toThrow(
      'target already exists',
    );
    await lifecycle.finish();
    expect(await fs.readFile(target, 'utf8')).toBe('existing');
    expect(manager.open).not.toHaveBeenCalled();
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
