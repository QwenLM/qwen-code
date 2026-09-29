/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Config,
  type ManagedToolFileHistoryBinding,
} from '@qwen-code/qwen-code-core';
import { ManagedToolFileHistorySessions } from './managed-tool-file-history-session.js';

describe('owned Runtime shared file history', () => {
  let cwd: string;
  let registry: ManagedToolFileHistorySessions;
  const configs = new Map<string, Config>();
  const find = (id: string) => configs.get(id);
  const available = (config: Config) => {
    if (configs.get(config.getSessionId()) !== config)
      throw new Error('Session unavailable');
  };
  beforeEach(async () => {
    cwd = await realpath(
      await mkdtemp(join(tmpdir(), 'managed-history-bind-')),
    );
    vi.stubEnv('QWEN_HOME', join(cwd, 'home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(cwd, 'runtime'));
    configs.clear();
    registry = new ManagedToolFileHistorySessions();
  });
  afterEach(async () => {
    for (const config of configs.values())
      await config.shutdown({ shutdownTelemetry: false });
    vi.unstubAllEnvs();
    await rm(cwd, { force: true, recursive: true });
  });
  function config() {
    const value = new Config({
      sessionId: randomUUID(),
      targetDir: cwd,
      cwd,
      model: 'test',
      debugMode: false,
      telemetry: { enabled: false },
      usageStatisticsEnabled: false,
    });
    configs.set(value.getSessionId(), value);
    return value;
  }
  function input(root: Config): ManagedToolFileHistoryBinding {
    return {
      ownerSessionId: randomUUID(),
      ownerRuntimeSessionId: root.getSessionId(),
      executionCwd: cwd,
      snapshots: [],
    };
  }

  it('shares a durable parent owner while isolating child execution cwd and read cache', async () => {
    const parent = config();
    const child = config();
    const binding = input(parent);
    const parentBinding = await registry.bind(parent, binding, find, available);
    const childCwd = join(cwd, 'worktree');
    await mkdir(childCwd);
    const childBinding = await registry.bind(
      child,
      { ...binding, executionCwd: childCwd },
      find,
      available,
    );
    expect(childBinding.owner).toBe(parentBinding.owner);
    expect(childBinding.toolConfig.getTargetDir()).toBe(childCwd);
    expect(childBinding.toolConfig.getFileHistoryService()).toBe(
      parent.getFileHistoryService(),
    );
    expect(childBinding.toolConfig.getFileReadCache()).not.toBe(
      parent.getFileReadCache(),
    );
    await expect(registry.dispose(parent)).rejects.toThrow('child execution');
    await registry.dispose(child);
    await registry.dispose(parent);
  });

  it('preserves custom ignore rules in a different child execution directory', async () => {
    const parent = config();
    const child = config();
    vi.spyOn(child, 'getFileFilteringOptions').mockReturnValue({
      respectGitIgnore: true,
      respectQwenIgnore: true,
      customIgnoreFiles: ['.searchignore'],
    });
    const binding = input(parent);
    await registry.bind(parent, binding, find, available);
    const childCwd = join(cwd, 'search-child');
    await mkdir(childCwd);
    await writeFile(join(childCwd, '.searchignore'), 'private.txt\n');
    await writeFile(join(childCwd, 'private.txt'), 'hidden');
    await writeFile(join(childCwd, 'public.txt'), 'visible');
    const childBinding = await registry.bind(
      child,
      { ...binding, executionCwd: childCwd },
      find,
      available,
    );
    expect(
      childBinding.toolConfig
        .getFileService()
        .filterFiles(
          ['private.txt', 'public.txt'],
          childBinding.toolConfig.getFileFilteringOptions(),
        ),
    ).toEqual(['public.txt']);
    await registry.dispose(child);
    await registry.dispose(parent);
  });

  it('binds exact same-cwd directory views and memory roots without mutating the Runtime Config', async () => {
    const parent = config();
    const child = config();
    const workerExtra = join(cwd, 'worker-extra');
    const gatewayExtra = join(cwd, 'gateway-extra');
    await mkdir(workerExtra);
    await mkdir(gatewayExtra);
    parent.getWorkspaceContext().addDirectory(workerExtra);
    child.getWorkspaceContext().addDirectory(workerExtra);
    const context = {
      workspaceDirectories: [cwd, gatewayExtra],
      memoryBaseDir: join(cwd, 'gateway-memory-not-created'),
      lsToolEnabled: true,
      grepOptions: { useRipgrep: false, useBuiltinRipgrep: false },
      outputLimits: { chars: null, lines: 7, charsExplicit: true },
      fileFilteringOptions: {
        respectGitIgnore: false,
        respectQwenIgnore: true,
        customIgnoreFiles: [],
      },
    };
    const binding = { ...input(parent), executionContext: context };
    const parentBinding = await registry.bind(parent, binding, find, available);
    const childBinding = await registry.bind(
      child,
      {
        ...binding,
        executionContext: {
          ...context,
          workspaceDirectories: [cwd],
          lsToolEnabled: false,
          grepOptions: { useRipgrep: true, useBuiltinRipgrep: false },
          outputLimits: { chars: 123, lines: null, charsExplicit: true },
        },
      },
      find,
      available,
    );
    expect(parentBinding.toolConfig).not.toBe(parent);
    expect(
      parentBinding.toolConfig.getWorkspaceContext().getDirectories(),
    ).toEqual([cwd, gatewayExtra]);
    expect(
      childBinding.toolConfig.getWorkspaceContext().getDirectories(),
    ).toEqual([cwd]);
    expect(parent.getWorkspaceContext().getDirectories()).toEqual([
      cwd,
      workerExtra,
    ]);
    expect(child.getWorkspaceContext().getDirectories()).toEqual([
      cwd,
      workerExtra,
    ]);
    expect(childBinding.toolConfig.getMemoryBaseDir()).toBe(
      context.memoryBaseDir,
    );
    expect(parentBinding.toolConfig.isLsToolEnabled()).toBe(true);
    expect(childBinding.toolConfig.isLsToolEnabled()).toBe(false);
    expect(parentBinding.toolConfig.getUseRipgrep()).toBe(false);
    expect(childBinding.toolConfig.getUseRipgrep()).toBe(true);
    expect(childBinding.toolConfig.getUseBuiltinRipgrep()).toBe(false);
    expect(parentBinding.toolConfig.getTruncateToolOutputThreshold()).toBe(
      Infinity,
    );
    expect(parentBinding.toolConfig.getTruncateToolOutputLines()).toBe(7);
    expect(childBinding.toolConfig.getTruncateToolOutputThreshold()).toBe(123);
    expect(childBinding.toolConfig.getTruncateToolOutputLines()).toBe(Infinity);
    expect(
      childBinding.toolConfig.isTruncateToolOutputThresholdExplicit(),
    ).toBe(true);
    expect(child.getUseBuiltinRipgrep()).toBe(true);
    expect(child.isTruncateToolOutputThresholdExplicit()).toBe(false);
    expect(childBinding.toolConfig.getFileFilteringOptions()).toEqual(
      context.fileFilteringOptions,
    );
    const readCache = childBinding.toolConfig.getFileReadCache();
    expect(readCache).not.toBe(parentBinding.toolConfig.getFileReadCache());
    expect(readCache).toBe(childBinding.toolConfig.getFileReadCache());
    context.memoryBaseDir = join(cwd, 'changed');
    context.grepOptions.useRipgrep = true;
    context.outputLimits.lines = 999;
    expect(parentBinding.toolConfig.getUseRipgrep()).toBe(false);
    expect(parentBinding.toolConfig.getTruncateToolOutputLines()).toBe(7);
    expect(parentBinding.toolConfig.getMemoryBaseDir()).not.toBe(
      context.memoryBaseDir,
    );
    await registry.dispose(child);
    await registry.dispose(parent);
  });

  it('restores backup bytes under the durable parent id after execution UUID replacement', async () => {
    const parent = config();
    const binding = input(parent);
    const { owner } = await registry.bind(parent, binding, find, available);
    const file = join(cwd, 'tracked.txt');
    await writeFile(file, 'before');
    await owner.checkpoint('parent-1');
    await owner.run(async () => {
      await owner.service.trackEdit(file);
      await writeFile(file, 'after');
    });
    const snapshot = owner.state();
    await registry.dispose(parent);
    const replacement = config();
    const restored = await registry.bind(
      replacement,
      {
        ...binding,
        ownerRuntimeSessionId: replacement.getSessionId(),
        snapshots: snapshot.snapshots,
      },
      find,
      available,
    );
    expect(restored.owner.state().snapshots).toEqual(snapshot.snapshots);
    await restored.owner.run(async () => {
      await restored.owner.service.rewind('parent-1');
    });
    expect(await readFile(file, 'utf8')).toBe('before');
    await registry.dispose(replacement);
  });

  it('coalesces identical bindings and rejects conflicting or duplicate owners', async () => {
    const parent = config();
    const binding = input(parent);
    const first = registry.bind(parent, binding, find, available);
    expect(registry.bind(parent, binding, find, available)).toBe(first);
    await first;
    await expect(
      registry.bind(
        parent,
        { ...binding, ownerSessionId: randomUUID() },
        find,
        available,
      ),
    ).rejects.toThrow('binding changed');
    const other = config();
    await expect(
      registry.bind(
        other,
        { ...binding, ownerRuntimeSessionId: other.getSessionId() },
        find,
        available,
      ),
    ).rejects.toThrow('already bound');
    await registry.dispose(parent);
  });

  it('rejects unknown owners and does not let a child overwrite restored snapshots', async () => {
    const parent = config();
    const child = config();
    const binding = input(parent);
    await expect(
      registry.bind(child, binding, find, available),
    ).rejects.toThrow('does not match');
    await registry.bind(parent, binding, find, available);
    await expect(
      registry.bind(
        child,
        {
          ...binding,
          snapshots: [
            {
              promptId: 'injected',
              timestamp: new Date().toISOString(),
              trackedFileBackups: {},
            },
          ],
        },
        find,
        available,
      ),
    ).rejects.toThrow('unavailable');
    await registry.dispose(parent);
  });
});
