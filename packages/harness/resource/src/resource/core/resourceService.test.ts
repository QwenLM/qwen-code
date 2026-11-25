/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ResourceService } from './resourceService.js';
import { ProjectResource } from './projectResource.js';
import type {
  FileChangeEvent,
  FileWatcherOptions,
} from '../../file-watcher/fileWatcher.js';
import type { ProjectResourceOptions } from './projectResource.js';

const state = vi.hoisted(() => ({
  listeners: new Map<string, (event: FileChangeEvent) => void>(),
  starts: 0,
  failWatching: false,
  failSkillWatching: false,
  noopCache: false,
  failCacheStop: false,
  failCacheUnwatch: false,
  syncSkillError: false,
  cacheError: undefined as FileWatcherOptions['onError'],
  skillErrors: [] as Array<FileWatcherOptions['onError']>,
}));
vi.mock('../../file-watcher/fileWatcher.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../file-watcher/fileWatcher.js')>();
  return {
    ...actual,
    createFileWatcher: (options?: FileWatcherOptions) => {
      if (options?.usePolling) state.cacheError = options.onError;
      else {
        state.skillErrors.push(options?.onError);
        if (state.syncSkillError)
          options?.onError?.(new Error('construct failed'));
      }
      return {
        isNoop: !!options?.usePolling && state.noopCache,
        watch: (
          { path }: { path: string },
          listener: (event: FileChangeEvent) => void,
        ) => {
          state.listeners.set(path, listener);
          return () => {
            state.listeners.delete(path);
            if (options?.usePolling && state.failCacheUnwatch)
              throw new Error('detach failed');
          };
        },
        start: async () => {
          state.starts++;
          if (
            state.failWatching ||
            (state.failSkillWatching && !options?.usePolling)
          )
            throw new Error('watch unavailable');
        },
        stop: async () => {
          if (options?.usePolling && state.failCacheStop)
            throw new Error('stop failed');
        },
      };
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  state.listeners.clear();
  state.starts = 0;
  state.failWatching = false;
  state.failSkillWatching = false;
  state.noopCache = false;
  state.failCacheStop = false;
  state.failCacheUnwatch = false;
  state.syncSkillError = false;
  state.cacheError = undefined;
  state.skillErrors = [];
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'resource-manager-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, '中文 workspace');
  const homeDir = join(root, 'home');
  await mkdir(cwd, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const options: ProjectResourceOptions = {
    cwd,
    homeDir,
    configDirName: '.qwen',
    isTrusted: true,
  };
  const service = new ResourceService();
  cleanups.push(() => service.dispose());
  return { service, options };
}

function findProjectSkill(
  handle: ReturnType<ResourceService['getProjectResource']>,
  name: string,
) {
  return handle.project.skills
    .getAllDiscoveredSkills()
    .find((skill) => skill.name === name);
}

describe('ResourceService', () => {
  it('keeps shared user Agent and OutputStyle snapshots until explicit reload', async () => {
    const { service, options } = await fixture();
    const configRoot = join(options.homeDir!, '.qwen');
    await mkdir(join(configRoot, 'agents'), { recursive: true });
    await mkdir(join(configRoot, 'output-styles'), { recursive: true });
    const agentFile = join(configRoot, 'agents', 'sample.md');
    const styleFile = join(configRoot, 'output-styles', 'sample.md');
    await writeFile(agentFile, '---\nname: sample\ndescription: Before\n---\nBefore');
    await writeFile(styleFile, '---\nname: sample\ndescription: Before\n---\nBefore');
    await service.initializeUserResources({ homeDir: options.homeDir });
    const user = service.getUserResource();
    expect(user.agents.getAllDiscoveredAgents()[0].prompt).toBe('Before');
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe('Before');
    await writeFile(agentFile, '---\nname: sample\ndescription: After\n---\nAfter');
    await writeFile(styleFile, '---\nname: sample\ndescription: After\n---\nAfter');
    expect(state.listeners.has(join(configRoot, 'agents'))).toBe(false);
    expect(state.listeners.has(join(configRoot, 'output-styles'))).toBe(false);
    await service.initializeUserResources({ homeDir: options.homeDir });
    expect(user.agents.getAllDiscoveredAgents()[0].prompt).toBe('Before');
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe('Before');
    await user.reloadAgents();
    await user.reloadOutputStyles();
    expect(user.agents.getAllDiscoveredAgents()[0].prompt).toBe('After');
    expect(user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe('After');
  });

  it('does not start watchers before the first resource request', async () => {
    await fixture();
    expect(state.starts).toBe(0);
  });

  it('reuses concurrent and later sessions without reloading their initial snapshot', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    const second = service.getProjectResource(options);
    expect(first.project).toBeInstanceOf(ProjectResource);
    expect(second.project).toBe(first.project);
    await Promise.all([first.ready, second.ready]);
    const reload = vi.spyOn(first.project, 'reloadSkills');
    const dispose = vi.spyOn(first.project, 'dispose');
    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await second.release();
    const later = service.getProjectResource(options);
    expect(later.project).toBe(first.project);
    await later.ready;
    expect(reload).not.toHaveBeenCalled();
    await later.release();
    await service.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('separates cwd, trust, resource sources and output style roots', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    const handles = [
      service.getProjectResource({ ...options, cwd: join(options.cwd, 'other') }),
      service.getProjectResource({ ...options, isTrusted: false }),
      service.getProjectResource({
        ...options,
        additionalDirectories: [join(options.cwd, 'extra')],
      }),
      service.getProjectResource({
        ...options,
        skillSettings: { allowedSources: ['user'] },
      }),
      service.getProjectResource({
        ...options,
        projectConfigDirOverride: join(options.cwd, 'original', '.qwen'),
      }),
    ];
    for (const handle of handles) {
      expect(handle.project).not.toBe(first.project);
      await handle.ready;
      await handle.release();
    }
    await first.release();
  });

  it('loads and invalidates original-project styles while sharing a worktree context', async () => {
    const { service, options } = await fixture();
    const worktree = join(options.cwd, 'worktree');
    const originalStyles = join(options.cwd, '.qwen', 'output-styles');
    const worktreeStyles = join(worktree, '.qwen', 'output-styles');
    await mkdir(originalStyles, { recursive: true });
    await mkdir(worktreeStyles, { recursive: true });
    const styleFile = join(originalStyles, 'example.md');
    await writeFile(
      styleFile,
      '---\nname: example\ndescription: Original\n---\nOriginal',
    );
    await writeFile(
      join(worktreeStyles, 'example.md'),
      '---\nname: example\ndescription: Worktree\n---\nWorktree',
    );
    const resourceOptions = {
      ...options,
      cwd: worktree,
      projectConfigDirOverride: join(options.cwd, '.qwen'),
    };
    const first = service.getProjectResource(resourceOptions);
    const second = service.getProjectResource(resourceOptions);
    await first.ready;
    expect(second.project).toBe(first.project);
    expect(
      first.project.outputStyles
        .getAllDiscoveredOutputStyles()
        .find((style) => style.name === 'example')?.prompt,
    ).toBe('Original');
    expect(state.listeners.has(worktreeStyles)).toBe(false);
    await writeFile(
      styleFile,
      '---\nname: example\ndescription: Updated\n---\nUpdated',
    );
    const invalidate = state.listeners.get(originalStyles);
    expect(invalidate).toBeDefined();
    invalidate?.({ path: styleFile, operation: 'change' });
    const next = service.getProjectResource(resourceOptions);
    await next.ready;
    expect(next.project).not.toBe(first.project);
    expect(
      first.project.outputStyles
        .getAllDiscoveredOutputStyles()
        .find((style) => style.name === 'example')?.prompt,
    ).toBe('Original');
    expect(
      next.project.outputStyles
        .getAllDiscoveredOutputStyles()
        .find((style) => style.name === 'example')?.prompt,
    ).toBe('Updated');
    await first.release();
    await second.release();
    await next.release();
  });

  it('isolates the project context for custom watchers instead of sharing', async () => {
    const { service, options } = await fixture();
    const fileWatcher = {
      isNoop: true,
      watch: () => () => {},
      start: async () => {},
      stop: async () => {},
    };
    const first = service.getProjectResource({ ...options, fileWatcher });
    const second = service.getProjectResource({ ...options, fileWatcher });
    expect(first.project).not.toBe(second.project);
    await Promise.all([first.ready, second.ready]);
    const dispose = vi.spyOn(first.project, 'dispose');
    await first.release();
    await first.release();
    expect(dispose).toHaveBeenCalledOnce();
    await second.release();
  });

  it('invalidates future sessions on agent changes without replacing an active snapshot', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    await first.ready;
    const agentsDir = join(options.cwd, '.qwen', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'review.md'),
      '---\nname: review\ndescription: Review code\n---\nReview code.\n',
    );
    state.listeners.get(agentsDir)?.({ path: agentsDir, operation: 'change' });
    const second = service.getProjectResource(options);
    expect(second.project).not.toBe(first.project);
    await second.ready;
    expect(first.project.agents.getAllDiscoveredAgents()).toHaveLength(0);
    expect(
      second.project.agents
        .getAllDiscoveredAgents()
        .map((agent) => agent.name),
    ).toContain('review');
    await first.release();
    await second.release();
  });

  it('shares Skill changes between active sessions', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    const second = service.getProjectResource(options);
    await first.watcherReady;
    const skillDir = join(options.cwd, '.qwen', 'skills');
    await mkdir(join(skillDir, 'example'), { recursive: true });
    await writeFile(
      join(skillDir, 'example', 'SKILL.md'),
      '---\nname: example\ndescription: Example skill\n---\nDo something.\n',
    );
    const notify = state.listeners.get(skillDir);
    expect(notify).toBeDefined();
    notify?.({
      path: join(skillDir, 'example', 'SKILL.md'),
      operation: 'change',
    });
    await vi.waitFor(() =>
      expect(findProjectSkill(second, 'example')).toBeDefined(),
    );
    await first.release();
    await second.release();
  });

  it('keeps active resources until their final handle is released during shutdown', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    const second = service.getProjectResource(options);
    await first.ready;
    const dispose = vi.spyOn(first.project, 'dispose');
    await service.dispose();
    expect(dispose).not.toHaveBeenCalled();
    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await second.release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops cache reuse when watchers fail while preserving the initial snapshot', async () => {
    const { service, options } = await fixture();
    state.failWatching = true;
    const first = service.getProjectResource(options);
    await first.ready;
    await expect(first.watcherReady).rejects.toThrow('watch unavailable');
    const second = service.getProjectResource(options);
    expect(second.project).not.toBe(first.project);
    await second.ready;
    await first.release();
    await second.release();
  });

  it('stops cache reuse on runtime errors without disposing active sessions', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    const second = service.getProjectResource(options);
    await first.watcherReady;
    const dispose = vi.spyOn(first.project, 'dispose');
    expect(state.cacheError).toBeTypeOf('function');
    state.cacheError?.(new Error('polling failed'));
    expect(state.listeners.has(join(options.cwd, '.qwen', 'agents'))).toBe(
      false,
    );
    expect(dispose).not.toHaveBeenCalled();
    const next = service.getProjectResource(options);
    const later = service.getProjectResource(options);
    expect(next.project).not.toBe(first.project);
    expect(later.project).not.toBe(next.project);
    await Promise.all([next.ready, later.ready]);
    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await second.release();
    expect(dispose).toHaveBeenCalledOnce();
    await next.release();
    await later.release();
  });

  it('reloads future sessions after a shared Skill watcher runtime error', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    const second = service.getProjectResource(options);
    await first.watcherReady;
    const dispose = vi.spyOn(first.project, 'dispose');
    const onError = state.skillErrors[0];
    expect(onError).toBeTypeOf('function');
    const skillDir = join(options.cwd, '.qwen', 'skills', 'new-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: new-skill\ndescription: New skill\n---\nNew skill',
    );
    onError?.(new Error('Skill watcher failed after ready'));
    expect(dispose).not.toHaveBeenCalled();
    expect(findProjectSkill(first, 'new-skill')).toBeUndefined();
    const next = service.getProjectResource(options);
    await next.watcherReady;
    expect(next.project).not.toBe(first.project);
    expect(findProjectSkill(next, 'new-skill')).toBeDefined();
    // Late errors from the old watcher must not evict its replacement.
    onError?.(new Error('late error'));
    const later = service.getProjectResource(options);
    expect(later.project).toBe(next.project);
    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await second.release();
    expect(dispose).toHaveBeenCalledOnce();
    await next.release();
    await later.release();
  });

  it('retains failed initial resources until all acquired handles are released', async () => {
    const { service, options } = await fixture();
    const initialize = vi
      .spyOn(
        ProjectResource.prototype as unknown as {
          initialize(): Promise<void>;
        },
        'initialize',
      )
      .mockRejectedValueOnce(new Error('initial load failed'));
    const first = service.getProjectResource(options);
    const second = service.getProjectResource(options);
    const dispose = vi.spyOn(first.project, 'dispose');
    try {
      expect(second.project).toBe(first.project);
      await expect(first.ready).rejects.toThrow('initial load failed');
      await expect(second.watcherReady).rejects.toThrow('initial load failed');
      expect(dispose).not.toHaveBeenCalled();
      const next = service.getProjectResource(options);
      expect(next.project).not.toBe(first.project);
      await next.watcherReady;
      await first.release();
      expect(dispose).not.toHaveBeenCalled();
      await second.release();
      expect(dispose).toHaveBeenCalledOnce();
      // A late failure signal must not revive an already disposed entry.
      state.skillErrors[0]?.(new Error('late failure'));
      await next.release();
      await service.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      initialize.mockRestore();
      await first.release();
      await second.release();
    }
  });

  it('preserves additional-directory precedence in shared resource keys', async () => {
    const { service, options } = await fixture();
    const directories = [
      join(options.cwd, 'first'),
      join(options.cwd, 'second'),
    ];
    for (const [index, directory] of directories.entries()) {
      const skillDir = join(directory, '.qwen', 'skills', 'example');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---\nname: example\ndescription: Directory ${index}\n---\nDirectory ${index}`,
      );
    }
    const first = service.getProjectResource({
      ...options,
      additionalDirectories: directories,
    });
    const reversed = service.getProjectResource({
      ...options,
      additionalDirectories: [...directories].reverse(),
    });
    await Promise.all([first.ready, reversed.ready]);
    expect(reversed.project).not.toBe(first.project);
    // Candidates stay in load order; the later additional root wins in the
    // host's last-wins precedence.
    expect(
      first.project.skills
        .getAllDiscoveredSkills()
        .map((skill) => skill.description),
    ).toEqual(['Directory 0', 'Directory 1']);
    expect(
      reversed.project.skills
        .getAllDiscoveredSkills()
        .map((skill) => skill.description),
    ).toEqual(['Directory 1', 'Directory 0']);
    await first.release();
    await reversed.release();
  });

  it('handles synchronous Skill watcher errors without caching the entry', async () => {
    const { service, options } = await fixture();
    state.syncSkillError = true;
    const first = service.getProjectResource(options);
    await first.ready;
    state.syncSkillError = false;
    const next = service.getProjectResource(options);
    expect(next.project).not.toBe(first.project);
    await next.ready;
    await first.release();
    await next.release();
  });

  it('continues detaching and releasing resources after an unwatch failure', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    await first.watcherReady;
    const dispose = vi.spyOn(first.project, 'dispose');
    state.failCacheUnwatch = true;
    expect(() => state.cacheError?.(new Error('backend failed'))).not.toThrow();
    expect(state.listeners.has(join(options.cwd, '.qwen', 'agents'))).toBe(
      false,
    );
    await first.release();
    expect(dispose).toHaveBeenCalledOnce();
    state.failCacheUnwatch = false;
  });

  it('attempts every idle resource disposal even when watcher stop and one disposal fail', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource(options);
    const second = service.getProjectResource({
      ...options,
      cwd: join(options.cwd, 'other'),
    });
    await Promise.all([first.watcherReady, second.watcherReady]);
    await first.release();
    await second.release();
    const originalDispose = first.project.dispose.bind(first.project);
    const firstDispose = vi
      .spyOn(first.project, 'dispose')
      .mockImplementation(async () => {
        await originalDispose();
        throw new Error('dispose failed');
      });
    const secondDispose = vi.spyOn(second.project, 'dispose');
    state.failCacheStop = true;
    await expect(service.dispose()).rejects.toThrow('stop failed');
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    state.failCacheStop = false;
  });

  it('removes invalidation watches when a resource watcher fails', async () => {
    const { service, options } = await fixture();
    state.failSkillWatching = true;
    const first = service.getProjectResource(options);
    await expect(first.watcherReady).rejects.toThrow('watch unavailable');
    await vi.waitFor(() =>
      expect(state.listeners.has(join(options.cwd, '.qwen', 'agents'))).toBe(
        false,
      ),
    );
    const dispose = vi.spyOn(first.project, 'dispose');
    expect(dispose).not.toHaveBeenCalled();
    await first.release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains an active acquisition when cache watching is unavailable synchronously', async () => {
    const { service, options } = await fixture();
    state.noopCache = true;
    const dispose = vi.spyOn(ProjectResource.prototype, 'dispose');
    try {
      const first = service.getProjectResource(options);
      await first.ready;
      expect(dispose).not.toHaveBeenCalled();
      await first.release();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      dispose.mockRestore();
    }
  });

  it('matches additional-directory cache keys to path resolution', async () => {
    const { service, options } = await fixture();
    const first = service.getProjectResource({
      ...options,
      additionalDirectories: ['extra', 'extra'],
    });
    const same = service.getProjectResource({
      ...options,
      additionalDirectories: [resolve('extra')],
    });
    const different = service.getProjectResource({
      ...options,
      additionalDirectories: [resolve(options.cwd, 'extra')],
    });
    expect(same.project).toBe(first.project);
    expect(different.project).not.toBe(first.project);
    await Promise.all([first.ready, different.ready]);
    await first.release();
    await same.release();
    await different.release();
  });

  it('rejects resource requests after shutdown', async () => {
    const { service, options } = await fixture();
    await service.dispose();
    expect(() => service.getProjectResource(options)).toThrow('disposed');
  });
});
