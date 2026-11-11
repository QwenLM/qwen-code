/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeSessionService } from '@qwen-code/core';
import { makeFakeConfig } from '../../../../core/src/test-utils/config.js';
import { ArtifactPresentationError } from './artifactRegistry.js';
import {
  createSessionArtifactRuntime,
  SessionArtifactRuntime,
} from './sessionArtifactRuntime.js';

const execFileAsync = promisify(execFile);

function toolResultEvent(toolUseResult: unknown): Record<string, unknown> {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu-file',
          content: 'ok',
        },
      ],
    },
    toolUseResult,
  };
}

describe('SessionArtifactRuntime', () => {
  let testRoot: string;
  let workspace: string;
  let outside: string;

  afterEach(() => vi.useRealTimers());

  it('recovers without a user turn after Desktop becomes available several seconds later', async () => {
    const runtime = createRuntime();
    const published: unknown[] = [];
    runtime.subscribe((snapshot) => published.push(snapshot));
    const host = vi
      .fn()
      .mockRejectedValue(new Error('REMOTE_CONTROL_ARTIFACT_UNAVAILABLE'));
    runtime.setHostRefresh(host);
    await runtime.initialize([]);
    vi.useFakeTimers();
    const recovery = runtime.recoverHostSnapshot();
    expect(runtime.recoverHostSnapshot()).toBe(recovery);
    await vi.advanceTimersByTimeAsync(3000);
    expect(host).toHaveBeenCalledTimes(4);
    expect(published).toEqual([]);
    expect(runtime.publishableSnapshot()).toBeNull();
    host.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(4000);
    await recovery;
    expect(host).toHaveBeenCalledTimes(5);
    expect(published).toEqual([[]]);
    await vi.runAllTimersAsync();
    expect(host).toHaveBeenCalledTimes(5);
  });

  it('bounds recovery and permits a new recovery after reconnect', async () => {
    const runtime = createRuntime();
    const host = vi
      .fn()
      .mockRejectedValue(new Error('REMOTE_CONTROL_ARTIFACT_STALE'));
    runtime.setHostRefresh(host);
    vi.useFakeTimers();
    const recovery = runtime.recoverHostSnapshot();
    await vi.runAllTimersAsync();
    await recovery;
    expect(host).toHaveBeenCalledTimes(6);
    expect(runtime.publishableSnapshot()).toBeNull();
    host.mockResolvedValue([]);
    await runtime.recoverHostSnapshot();
    expect(host).toHaveBeenCalledTimes(7);
    expect(runtime.publishableSnapshot()).toEqual([]);
  });

  it.each([
    'REMOTE_CONTROL_ARTIFACT_READ_FAILED',
    'resolve_session_artifacts timed out after 10000ms',
  ])('retries transient failure %s', async (message) => {
    const runtime = createRuntime();
    const host = vi
      .fn()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValue([]);
    runtime.setHostRefresh(host);
    vi.useFakeTimers();
    const recovery = runtime.recoverHostSnapshot();
    await vi.runAllTimersAsync();
    await recovery;
    expect(host).toHaveBeenCalledTimes(2);
  });

  it('does not retry identity errors or enable Host recovery in pure CLI mode', async () => {
    const runtime = createRuntime();
    await runtime.recoverHostSnapshot();
    const host = vi
      .fn()
      .mockRejectedValue(new Error('REMOTE_CONTROL_ARTIFACT_IDENTITY'));
    runtime.setHostRefresh(host);
    vi.useFakeTimers();
    await runtime.recoverHostSnapshot();
    await vi.runAllTimersAsync();
    expect(host).toHaveBeenCalledTimes(1);
  });

  it('cancels pending retry timers when the Host is removed', async () => {
    const runtime = createRuntime();
    const host = vi
      .fn()
      .mockRejectedValue(new Error('REMOTE_CONTROL_ARTIFACT_UNAVAILABLE'));
    runtime.setHostRefresh(host);
    vi.useFakeTimers();
    const recovery = runtime.recoverHostSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(host).toHaveBeenCalledTimes(1);
    runtime.clearHostRefresh();
    await vi.runAllTimersAsync();
    await recovery;
    expect(host).toHaveBeenCalledTimes(1);
  });

  it('does not delay a normal refresh behind recovery backoff', async () => {
    const runtime = createRuntime();
    const host = vi
      .fn()
      .mockRejectedValueOnce(new Error('REMOTE_CONTROL_ARTIFACT_STALE'))
      .mockResolvedValue([]);
    runtime.setHostRefresh(host);
    vi.useFakeTimers();
    const recovery = runtime.recoverHostSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    await expect(runtime.refreshHostSnapshot()).resolves.toEqual([]);
    await vi.runAllTimersAsync();
    await recovery;
    expect(host).toHaveBeenCalledTimes(2);
  });

  beforeEach(async () => {
    testRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'session-artifacts-')),
    );
    workspace = path.join(testRoot, 'workspace');
    outside = path.join(testRoot, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  function createRuntime(): SessionArtifactRuntime {
    return new SessionArtifactRuntime({
      workingDirectory: workspace,
      initialWorkspaceRoots: [workspace],
    });
  }

  it('does not republish an unchanged snapshot during transcript history merge', async () => {
    const artifactPath = path.join(workspace, 'report.md');
    await fs.writeFile(artifactPath, '# report\n');
    const history = [
      toolResultEvent({
        type: 'create',
        filePath: artifactPath,
        content: '# report\n',
        structuredPatch: [],
        originalFile: null,
      }),
    ];
    const runtime = createRuntime();
    const subscriber = vi.fn();
    runtime.subscribe(subscriber);

    await runtime.initialize(history);
    await runtime.initialize(history, { forcePublish: false });

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'report.md' })],
      undefined,
    );
  });

  it.each([false, true])(
    'keeps artifact validation on the committed workspace until enter settles (failure=%s)',
    async (failEnter) => {
      const artifactPath = path.join(workspace, 'report.txt');
      await fs.writeFile(artifactPath, 'original');
      const canonicalPath = await fs.realpath(artifactPath);
      const config = makeFakeConfig({
        targetDir: workspace,
        cwd: workspace,
        acpMode: true,
        sessionPersistence: false,
      });
      const runtime = createSessionArtifactRuntime(config);
      await runtime.initialize();
      await runtime.present(['report.txt']);
      let release!: () => void;
      let projected!: () => void;
      const persistence = new Promise<void>((resolve) => {
        release = resolve;
      });
      const projection = new Promise<void>((resolve) => {
        projected = resolve;
      });
      const enter = worktreeSessionService.enter(
        {
          config,
          sessionId: config.getSessionId(),
          phase: 'runtime',
          recordWorktreeState: async () => {
            projected();
            await persistence;
            if (failEnter) throw new Error('transcript unavailable');
          },
        },
        {
          preparedForSessionId: config.getSessionId(),
          created: false,
          settings: {
            name: 'external',
            path: outside,
            worktreeCwd: outside,
            originalCwd: workspace,
            baseSha: '',
            hookBased: true,
            enteredExisting: true,
          },
        },
      );
      const settled = enter.catch((error: unknown) => error);
      try {
        await projection;
        expect(config.getWorkingDir()).toBe(outside);
        expect(await runtime.revalidate(canonicalPath)).toEqual({
          status: 'unchanged',
        });
        release();
        await settled;
        expect(config.getWorkingDir()).toBe(failEnter ? workspace : outside);
        expect(await runtime.revalidate(canonicalPath)).toMatchObject({
          status: failEnter ? 'unchanged' : 'changed',
        });
        expect(runtime.get(canonicalPath)?.entry).toMatchObject({
          path: canonicalPath,
          display_path: failEnter ? 'report.txt' : canonicalPath,
        });
        expect(runtime.get(canonicalPath)?.entry.relative_path).toBe(
          failEnter ? 'report.txt' : undefined,
        );
      } finally {
        release();
        await settled;
        await config.dispose();
      }
    },
  );

  it('follows runtime checkout changes and canonicalizes explicitly presented external files', async () => {
    const originalFile = path.join(workspace, 'report.txt');
    const worktreeFile = path.join(outside, 'report.txt');
    await fs.writeFile(originalFile, 'original');
    await fs.writeFile(worktreeFile, 'worktree');
    await fs.symlink(originalFile, path.join(outside, 'escape.txt'));
    let cwd = workspace;
    const runtime = createSessionArtifactRuntime({
      getWorkingDir: () => cwd,
      getSessionArtifactProjectRoot: () => workspace,
      getSessionId: () => 'artifact-worktree-transition',
      getSessionPersistence: () => false,
      getWorkspaceContext: () => ({
        getInitialDirectories: () => [workspace],
        getDirectories: () => [cwd],
      }),
    });
    await runtime.initialize();
    await runtime.present(['report.txt']);

    cwd = outside;
    const presented = await runtime.present(['report.txt', worktreeFile]);
    expect(presented.presented).toEqual([
      expect.objectContaining({
        path: await fs.realpath(worktreeFile),
        relative_path: 'report.txt',
      }),
    ]);
    const canonicalOriginalFile = await fs.realpath(originalFile);
    const external = await runtime.present([originalFile, 'escape.txt']);
    expect(external.presented).toEqual([
      expect.objectContaining({
        path: canonicalOriginalFile,
        display_path: canonicalOriginalFile,
      }),
    ]);
    expect(external.presented[0]).not.toHaveProperty('relative_path');

    cwd = workspace;
    expect(
      await runtime.revalidate(await fs.realpath(worktreeFile)),
    ).toMatchObject({
      status: 'changed',
    });
    expect((await runtime.present(['report.txt'])).presented).toEqual([
      expect.objectContaining({
        path: canonicalOriginalFile,
        relative_path: 'report.txt',
      }),
    ]);
  });

  it('retains ImageGen candidates through Host refresh and distinguishes failure from authorization', async () => {
    const imagePath = path.join(workspace, 'image.png');
    await fs.writeFile(imagePath, 'image');
    const runtime = createRuntime();
    await runtime.initialize([]);
    runtime.setHostRefresh(async () => []);
    const observations: unknown[] = [];
    runtime.subscribe((_snapshot, observation) => {
      if (observation) observations.push(observation);
    });
    await runtime.observeEvent(
      toolResultEvent({ filePath: imagePath, requestId: 'image-request' }),
    );
    await runtime.waitForPendingRefresh();
    expect(runtime.snapshot()).toEqual([]);
    const canonicalPath = await fs.realpath(imagePath);
    expect(observations).toEqual([
      expect.objectContaining({
        changedArtifacts: [expect.objectContaining({ path: canonicalPath })],
      }),
    ]);
    runtime.setHostRefresh(async () => [
      {
        path: imagePath,
        display_path: 'image.png',
        name: 'image.png',
        kind: 'presented',
      },
    ]);
    await expect(runtime.refreshHostSnapshot()).resolves.toEqual([
      expect.objectContaining({ path: canonicalPath, kind: 'presented' }),
    ]);
    runtime.setHostRefresh(async () => {
      throw new Error('Host unavailable');
    });
    await expect(runtime.refreshHostSnapshot()).resolves.toBeNull();
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({ path: canonicalPath }),
    ]);
    runtime.setHostRefresh(async () => []);
    await expect(runtime.refreshHostSnapshot()).resolves.toEqual([]);
  });

  it('publishes and returns an empty complete snapshot during initialization', async () => {
    const runtime = createRuntime();
    const published: unknown[] = [];
    runtime.subscribe((snapshot) => published.push(snapshot));

    await expect(runtime.initialize([])).resolves.toEqual([]);

    expect(runtime.snapshot()).toEqual([]);
    expect(published).toEqual([[]]);
  });

  it('retains current-turn candidates on refresh failure without authorizing the CLI fallback', async () => {
    const imagePath = path.join(workspace, 'candidate.png');
    await fs.writeFile(imagePath, 'image');
    const runtime = createRuntime();
    const host = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error('REMOTE_CONTROL_ARTIFACT_STALE'));
    runtime.setHostRefresh(host);
    await runtime.refreshEffectiveSnapshot();
    const subscriber = vi.fn();
    runtime.subscribe(subscriber);
    await runtime.observeEvent(
      toolResultEvent({
        type: 'create',
        filePath: imagePath,
        content: 'image',
        originalFile: null,
        structuredPatch: [],
      }),
    );
    await runtime.waitForPendingRefresh();
    expect(subscriber).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        changedArtifacts: [
          expect.objectContaining({ path: await fs.realpath(imagePath) }),
        ],
      }),
    );
    await expect(runtime.refreshHostSnapshot()).resolves.toBeNull();
    expect(runtime.snapshot()).toEqual([]);
  });

  it('deduplicates a changed file by canonical path, replaces metadata, and removes deletion', async () => {
    const artifactPath = path.join(workspace, 'report.md');
    const aliasPath = path.join(workspace, 'report-alias.md');
    await fs.writeFile(artifactPath, 'first');
    await fs.symlink(artifactPath, aliasPath);
    const canonicalPath = await fs.realpath(artifactPath);
    const runtime = createRuntime();
    await runtime.initialize([]);

    const created = await runtime.observeEvent(
      toolResultEvent({
        type: 'create',
        filePath: aliasPath,
        content: 'first',
        structuredPatch: [],
        originalFile: null,
      }),
    );

    expect(created?.snapshot).toEqual([
      expect.objectContaining({
        path: canonicalPath,
        size: 5,
        kind: 'changed',
        additions: 1,
        deletions: 0,
        is_new: true,
      }),
    ]);

    await fs.writeFile(artifactPath, 'updated payload');
    const updated = await runtime.observeEvent(
      toolResultEvent({
        filePath: artifactPath,
        oldString: 'first',
        newString: 'updated payload',
        originalFile: 'first',
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-first', '+updated payload'],
          },
        ],
      }),
    );

    expect(updated?.snapshot).toEqual([
      expect.objectContaining({
        path: canonicalPath,
        size: 15,
        kind: 'changed',
        additions: 1,
        deletions: 1,
        is_new: false,
      }),
    ]);

    await fs.unlink(artifactPath);
    const deleted = await runtime.observeEvent(
      toolResultEvent({
        filePath: artifactPath,
        oldString: 'updated payload',
        newString: '',
        originalFile: 'updated payload',
        structuredPatch: [],
      }),
    );

    expect(deleted?.snapshot).toEqual([]);
    expect(runtime.snapshot()).toEqual([]);
  });

  it('accepts external files and symlink aliases while rejecting directories', async () => {
    const outsideFile = path.join(outside, 'secret.md');
    const escapePath = path.join(workspace, 'escape.md');
    const directoryPath = path.join(workspace, 'folder.md');
    await fs.writeFile(outsideFile, 'secret');
    await fs.symlink(outsideFile, escapePath);
    await fs.mkdir(directoryPath);
    const canonicalOutsideFile = await fs.realpath(outsideFile);
    const runtime = createRuntime();
    await runtime.initialize([]);

    const observation = await runtime.present([outsideFile, escapePath]);

    expect(observation.presented).toEqual([
      expect.objectContaining({
        path: canonicalOutsideFile,
        display_path: canonicalOutsideFile,
        name: 'secret.md',
      }),
    ]);
    expect(observation.presented[0]).not.toHaveProperty('relative_path');
    await expect(runtime.present([directoryPath])).rejects.toBeInstanceOf(
      ArtifactPresentationError,
    );
    expect(runtime.snapshot()).toEqual(observation.snapshot);
  });

  it('uses a validated App snapshot as the upload index without replacing the CLI snapshot', async () => {
    const cliPath = path.join(workspace, 'cli.md');
    const appPath = path.join(outside, 'app.bin');
    const changedAppPath = path.join(workspace, 'existing.json');
    await fs.writeFile(cliPath, 'cli');
    await fs.writeFile(appPath, 'app');
    await fs.writeFile(changedAppPath, '{}');
    const canonicalAppPath = await fs.realpath(appPath);
    const runtime = createRuntime();
    await runtime.initialize([]);
    await runtime.present([cliPath]);

    const appSnapshot = await runtime.useExternalSnapshot([
      {
        path: appPath,
        display_path: 'Downloads/app.bin',
        name: 'App output',
        group: { key: 'outputs', name: 'Outputs' },
        relative_path: 'app.bin',
        size: 999,
        mtime: 999,
        kind: 'presented',
      },
      {
        path: changedAppPath,
        display_path: 'existing.json',
        name: 'existing.json',
        kind: 'changed',
        additions: 1,
        deletions: 0,
        is_new: false,
      },
    ]);

    expect(appSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: canonicalAppPath,
          display_path: canonicalAppPath,
          name: 'app.bin',
          group: { key: 'outputs', name: 'Outputs' },
          size: 3,
          mtime: expect.any(Number),
          kind: 'presented',
        }),
        expect.objectContaining({
          path: await fs.realpath(changedAppPath),
          display_path: 'existing.json',
          name: 'existing.json',
          size: 2,
          kind: 'changed',
          additions: 1,
          deletions: 0,
          is_new: false,
        }),
      ]),
    );
    expect(appSnapshot[0]).not.toHaveProperty('relative_path');
    expect(runtime.get(await fs.realpath(cliPath))).toBeUndefined();
    expect(runtime.get(canonicalAppPath)).toBeDefined();
    expect(runtime.get(await fs.realpath(changedAppPath))).toBeDefined();
    expect(runtime.get(canonicalAppPath)?.entry.mtime).not.toBe(999);
    expect(runtime.cliSnapshot()).toEqual([
      expect.objectContaining({ path: await fs.realpath(cliPath) }),
    ]);

    runtime.clearExternalSnapshot();
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({ path: await fs.realpath(cliPath) }),
    ]);
  });

  it('treats an App snapshot path as a literal absolute filesystem path', async () => {
    const artifactPath = path.join(workspace, '100% # ready.json');
    await fs.writeFile(artifactPath, '{}');
    const runtime = createRuntime();
    await runtime.initialize([]);

    await expect(
      runtime.useExternalSnapshot([
        {
          path: artifactPath,
          display_path: '100% # ready.json',
          name: '100% # ready.json',
          kind: 'changed',
          additions: 1,
          deletions: 0,
          is_new: true,
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        path: await fs.realpath(artifactPath),
        display_path: '100% # ready.json',
        name: '100% # ready.json',
      }),
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a non-regular FIFO without indexing',
    async () => {
      const fifoPath = path.join(workspace, 'artifact.fifo');
      await execFileAsync('mkfifo', [fifoPath]);
      const runtime = createRuntime();
      await runtime.initialize([]);

      await expect(runtime.present([fifoPath])).rejects.toBeInstanceOf(
        ArtifactPresentationError,
      );
      expect(runtime.snapshot()).toEqual([]);
    },
  );

  it('publishes cloned cumulative snapshots once, isolates subscriber failures, and disposes subscriptions', async () => {
    const firstPath = path.join(workspace, 'first.md');
    const secondPath = path.join(workspace, 'second.md');
    const thirdPath = path.join(workspace, 'third.md');
    await fs.writeFile(firstPath, 'first');
    await fs.writeFile(secondPath, 'second');
    await fs.writeFile(thirdPath, 'third');
    const runtime = createRuntime();
    const received: string[][] = [];
    let firstPresentationNotified = false;

    runtime.subscribe((snapshot) => {
      if (snapshot[0]) {
        snapshot[0].name = 'corrupted.md';
      }
      throw new Error('subscriber failed');
    });
    const dispose = runtime.subscribe((snapshot) => {
      received.push(snapshot.map(({ name }) => name));
      if (snapshot.some(({ name }) => name === 'first.md')) {
        firstPresentationNotified = true;
      }
    });

    await expect(runtime.initialize([])).resolves.toEqual([]);
    expect(firstPresentationNotified).toBe(false);
    await expect(runtime.present([firstPath])).resolves.toEqual(
      expect.objectContaining({
        snapshot: [expect.objectContaining({ name: 'first.md' })],
      }),
    );
    expect(firstPresentationNotified).toBe(true);
    await runtime.present([firstPath]);
    await runtime.present([secondPath]);

    expect(received).toEqual([[], ['first.md'], ['first.md', 'second.md']]);
    expect(runtime.snapshot().map(({ name }) => name)).toEqual([
      'first.md',
      'second.md',
    ]);

    dispose();
    await runtime.present([thirdPath]);
    expect(received).toHaveLength(3);
  });

  describe('host refresh', () => {
    it('publishes an external host snapshot when the refresh callback succeeds', async () => {
      const cliPath = path.join(workspace, 'cli.md');
      const hostPath = path.join(outside, 'host.md');
      await fs.writeFile(cliPath, 'cli');
      await fs.writeFile(hostPath, 'host');
      const canonicalHostPath = await fs.realpath(hostPath);
      const runtime = createRuntime();
      await runtime.initialize([]);
      await runtime.present([cliPath]);

      const published: unknown[][] = [];
      runtime.subscribe((snapshot) =>
        published.push(snapshot.map(({ name }) => name)),
      );

      runtime.setHostRefresh(async () => [
        {
          path: hostPath,
          display_path: 'host.md',
          name: 'host.md',
          kind: 'presented' as const,
        },
      ]);
      await runtime.refreshEffectiveSnapshot();
      const snapshot = runtime.snapshot();

      expect(published).toEqual([['host.md']]);
      expect(snapshot).toEqual([
        expect.objectContaining({
          path: canonicalHostPath,
          display_path: canonicalHostPath,
          name: 'host.md',
        }),
      ]);
      expect(snapshot[0]).not.toHaveProperty('relative_path');
      expect(runtime.cliSnapshot().map(({ name }) => name)).toEqual(['cli.md']);
    });

    it('does not publish CLI fallback when the first Host refresh fails', async () => {
      const cliPath = path.join(workspace, 'cli.md');
      await fs.writeFile(cliPath, 'cli');
      const runtime = createRuntime();
      await runtime.initialize([]);
      await runtime.present([cliPath]);

      const published: unknown[][] = [];
      runtime.subscribe((snapshot) =>
        published.push(snapshot.map(({ name }) => name)),
      );

      runtime.setHostRefresh(async () => {
        throw new Error('host unavailable');
      });
      await runtime.refreshEffectiveSnapshot();

      expect(published).toEqual([]);
      expect(runtime.cliSnapshot().map(({ name }) => name)).toEqual(['cli.md']);
    });

    it('preserves previous Host snapshot when a subsequent refresh fails', async () => {
      const hostPath = path.join(workspace, 'host.md');
      await fs.writeFile(hostPath, 'host');
      const runtime = createRuntime();
      await runtime.initialize([]);

      const published: unknown[][] = [];
      runtime.subscribe((snapshot) =>
        published.push(snapshot.map(({ name }) => name)),
      );

      let shouldFail = false;
      runtime.setHostRefresh(async () => {
        if (shouldFail) throw new Error('host unavailable');
        return [
          {
            path: hostPath,
            display_path: 'host.md',
            name: 'host.md',
            kind: 'presented' as const,
          },
        ];
      });
      await runtime.refreshEffectiveSnapshot();
      expect(published).toEqual([['host.md']]);

      shouldFail = true;
      await runtime.refreshEffectiveSnapshot();
      expect(runtime.snapshot().map(({ name }) => name)).toEqual(['host.md']);
      await expect(runtime.refreshHostSnapshot()).resolves.toBeNull();
    });

    it('discards stale Host responses after a generation change', async () => {
      const path1 = path.join(workspace, 'old.md');
      const path2 = path.join(workspace, 'new.md');
      await fs.writeFile(path1, 'old');
      await fs.writeFile(path2, 'new');
      const runtime = createRuntime();
      await runtime.initialize([]);

      let resolveFirst: (() => void) | undefined;
      const firstWait = new Promise<void>(
        (resolve) => (resolveFirst = resolve),
      );

      runtime.setHostRefresh(async () => {
        await firstWait;
        return [
          {
            path: path1,
            display_path: 'old.md',
            name: 'old.md',
            kind: 'presented' as const,
          },
        ];
      });
      const firstRefresh = runtime.refreshEffectiveSnapshot();

      runtime.setHostRefresh(async () => [
        {
          path: path2,
          display_path: 'new.md',
          name: 'new.md',
          kind: 'presented' as const,
        },
      ]);
      const secondRefresh = runtime.refreshEffectiveSnapshot();

      resolveFirst!();
      await firstRefresh;
      await secondRefresh;

      expect(runtime.snapshot().map(({ name }) => name)).toEqual(['new.md']);
    });

    it('does not publish CLI historical snapshot when Host refresh is set before initialize', async () => {
      const cliPath = path.join(workspace, 'report.md');
      await fs.writeFile(cliPath, 'content');
      const runtime = createRuntime();

      const published: unknown[][] = [];
      runtime.subscribe((snapshot) =>
        published.push(snapshot.map(({ name }) => name)),
      );

      runtime.setHostRefresh(async () => []);
      await runtime.initialize([
        {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu-file',
                content: 'ok',
              },
            ],
          },
          toolUseResult: {
            type: 'create',
            filePath: cliPath,
            content: 'content',
            structuredPatch: [],
            originalFile: null,
          },
        },
      ]);

      expect(published).toEqual([]);
      expect(runtime.cliSnapshot()).toEqual([
        expect.objectContaining({ name: 'report.md' }),
      ]);
    });

    it('clears the effective snapshot when host returns an empty list', async () => {
      const cliPath = path.join(workspace, 'cli.md');
      await fs.writeFile(cliPath, 'cli');
      const runtime = createRuntime();
      await runtime.initialize([]);
      await runtime.present([cliPath]);

      const published: unknown[][] = [];
      runtime.subscribe((snapshot) =>
        published.push(snapshot.map(({ name }) => name)),
      );

      runtime.setHostRefresh(async () => []);
      await runtime.refreshEffectiveSnapshot();

      expect(published).toEqual([[]]);
      expect(runtime.snapshot()).toEqual([]);
    });

    it('defers publish to the refresh chain when observeEvent triggers with active host refresh', async () => {
      const filePath = path.join(workspace, 'new.md');
      await fs.writeFile(filePath, 'content');
      const hostPath = path.join(workspace, 'host.md');
      await fs.writeFile(hostPath, 'host');
      const runtime = createRuntime();
      await runtime.initialize([]);

      const published: unknown[][] = [];
      runtime.subscribe((snapshot) =>
        published.push(snapshot.map(({ name }) => name)),
      );

      runtime.setHostRefresh(async () => [
        {
          path: hostPath,
          display_path: 'host.md',
          name: 'host.md',
          kind: 'presented' as const,
        },
      ]);

      await runtime.observeEvent(
        toolResultEvent({
          type: 'create',
          filePath,
          content: 'content',
          structuredPatch: [],
          originalFile: null,
        }),
      );

      await runtime.waitForPendingRefresh();

      expect(published.length).toBeGreaterThanOrEqual(1);
      expect(published.at(-1)).toEqual(['host.md']);
    });

    it('serializes refreshes so an older callback cannot overwrite a newer result', async () => {
      const hostPath1 = path.join(workspace, 'old.md');
      const hostPath2 = path.join(workspace, 'new.md');
      await fs.writeFile(hostPath1, 'old');
      await fs.writeFile(hostPath2, 'new');
      const runtime = createRuntime();
      await runtime.initialize([]);

      let resolveFirst: (() => void) | undefined;
      const firstCallPromise = new Promise<void>(
        (resolve) => (resolveFirst = resolve),
      );
      let callCount = 0;
      runtime.setHostRefresh(async () => {
        callCount += 1;
        if (callCount === 1) {
          await firstCallPromise;
          return [
            {
              path: hostPath1,
              display_path: 'old.md',
              name: 'old.md',
              kind: 'presented' as const,
            },
          ];
        }
        return [
          {
            path: hostPath2,
            display_path: 'new.md',
            name: 'new.md',
            kind: 'presented' as const,
          },
        ];
      });

      const first = runtime.refreshEffectiveSnapshot();
      const second = runtime.refreshEffectiveSnapshot();

      resolveFirst!();
      await first;
      await second;

      expect(runtime.snapshot().map(({ name }) => name)).toEqual(['new.md']);
    });

    it('restores the CLI snapshot when clearHostRefresh is called', async () => {
      const cliPath = path.join(workspace, 'cli.md');
      const hostPath = path.join(workspace, 'host.md');
      await fs.writeFile(cliPath, 'cli');
      await fs.writeFile(hostPath, 'host');
      const runtime = createRuntime();
      await runtime.initialize([]);
      await runtime.present([cliPath]);

      runtime.setHostRefresh(async () => [
        {
          path: hostPath,
          display_path: 'host.md',
          name: 'host.md',
          kind: 'presented' as const,
        },
      ]);
      await runtime.refreshEffectiveSnapshot();
      expect(runtime.snapshot().map(({ name }) => name)).toEqual(['host.md']);

      runtime.clearHostRefresh();
      expect(runtime.snapshot().map(({ name }) => name)).toEqual(['cli.md']);
    });
  });
});
