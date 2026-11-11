/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  FileChangeEvent,
  FileWatcherOptions,
  WatchRequest,
} from '../../file-watcher/fileWatcher.js';
import { UserSkillProvider } from '../kinds/skills/providers/userSkillProvider.js';
import { ProjectSkillProvider } from '../kinds/skills/providers/projectSkillProvider.js';
import { UserAgentProvider } from '../kinds/agents/providers/userAgentProvider.js';
import { OutputStyleProvider } from '../kinds/outputStyles/providers/outputStyleProvider.js';
import { ResourceService } from '../core/resourceService.js';
import { UserResource } from '../core/userResource.js';
import type { UserResourceOptions } from '../core/userResource.js';
import type { ProjectResourceOptions } from '../core/projectResource.js';

const state = vi.hoisted(() => ({
  watchers: [] as Array<{
    options?: FileWatcherOptions;
    requests: Array<{
      request: WatchRequest;
      listener: (event: FileChangeEvent) => void | Promise<void>;
      active: boolean;
    }>;
    stopped: boolean;
  }>,
}));
vi.mock('../../file-watcher/fileWatcher.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../file-watcher/fileWatcher.js')>();
  return {
    ...actual,
    createFileWatcher: (options?: FileWatcherOptions) => {
      const watcher = {
        options,
        requests: [] as (typeof state.watchers)[number]['requests'],
        stopped: false,
      };
      state.watchers.push(watcher);
      return {
        isNoop: false,
        watch: (
          request: WatchRequest,
          listener: (event: FileChangeEvent) => void | Promise<void>,
        ) => {
          const registration = { request, listener, active: true };
          watcher.requests.push(registration);
          return () => {
            registration.active = false;
          };
        },
        start: async () => {},
        stop: async () => {
          watcher.stopped = true;
        },
      };
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  state.watchers = [];
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shared-user-skills-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const homeDir = join(root, '用户 home');
  const cwd = join(root, '项目 A');
  const otherCwd = join(root, '项目 B');
  await Promise.all(
    [homeDir, cwd, otherCwd].map((dir) => mkdir(dir, { recursive: true })),
  );
  const service = new ResourceService();
  cleanups.push(() => service.dispose());
  const options = { homeDir, cwd, isTrusted: true };
  return { service, options, homeDir, cwd, otherCwd };
}

async function skill(root: string, name: string, description: string) {
  const dir = join(root, '.qwen', 'skills', name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\nBody`,
  );
  return file;
}

function registrations(path: string) {
  return state.watchers
    .flatMap((watcher) => watcher.requests)
    .filter((entry) => entry.active && entry.request.path === path);
}

async function emit(root: string, file: string) {
  const entries = registrations(join(root, '.qwen', 'skills'));
  expect(entries).toHaveLength(1);
  await entries[0].listener({ path: file, operation: 'change' });
}

type SessionOptions = ProjectResourceOptions & UserResourceOptions;
type TestSession = ReturnType<typeof session>;

/** Mimics a session: process user resource, Skill view and project handle. */
function session(service: ResourceService, options: SessionOptions) {
  const user = service.getUserResource({
    homeDir: options.homeDir,
    configDirName: options.configDirName,
    globalConfigDirOverride: options.globalConfigDirOverride,
    userAgentSkillsDirOverride: options.userAgentSkillsDirOverride,
    loadFromAgentsDirectory: options.loadFromAgentsDirectory,
  });
  const userSkills = user.skills;
  const handle = service.getProjectResource(options);
  const composeReady = () =>
    Promise.all([user.ready, userSkills.ready, handle.ready]).then(
      () => undefined,
    );
  return {
    user,
    userSkills,
    project: handle.project,
    get ready() {
      return composeReady();
    },
    get watcherReady() {
      // Watching is armed only after the initial load, like the old handle.
      return composeReady().then(() =>
        Promise.all([
          user.watcherReady,
          userSkills.watcherReady,
          handle.watcherReady,
        ]).then(() => undefined),
      );
    },
    release: async () => {
      await handle.release();
    },
  };
}

function userSkill(handle: TestSession, name: string) {
  return handle.userSkills
    .getAllDiscoveredSkills()
    .find((skill) => skill.name === name);
}

function projectSkill(handle: TestSession, name: string) {
  return handle.project.skills
    .getAllDiscoveredSkills()
    .find((skill) => skill.name === name);
}

describe('shared user Skills and Commands', () => {
  it('loads user sources once across concurrent and later cwds while keeping scopes separate', async () => {
    const { service, options, homeDir, cwd, otherCwd } = await fixture();
    await Promise.all([
      skill(homeDir, 'same', 'User'),
      skill(cwd, 'same', 'A'),
      skill(otherCwd, 'same', 'B'),
    ]);
    const commands = join(homeDir, '.qwen', 'commands');
    await mkdir(commands, { recursive: true });
    await writeFile(
      join(commands, 'hello.md'),
      '---\ndescription: User command\n---\nHello',
    );
    const users = vi.spyOn(UserSkillProvider.prototype, 'load');
    const projects = vi.spyOn(ProjectSkillProvider.prototype, 'load');
    const first = session(service, options);
    const second = session(service, { ...options, cwd: otherCwd });
    expect(first.project).not.toBe(second.project);
    expect(first.user).toBe(second.user);
    await Promise.all([first.watcherReady, second.watcherReady]);
    expect(users).toHaveBeenCalledTimes(1);
    expect(projects).toHaveBeenCalledTimes(2);
    expect(userSkill(first, 'hello')?.description).toBe('User command');
    expect(userSkill(first, 'same')?.description).toBe('User');
    expect(projectSkill(first, 'same')?.description).toBe('A');
    expect(userSkill(second, 'same')?.description).toBe('User');
    expect(projectSkill(second, 'same')?.description).toBe('B');
    expect(registrations(join(homeDir, '.qwen', 'skills'))).toHaveLength(1);
    expect(registrations(commands)).toHaveLength(1);
    const later = session(service, { ...options, cwd: join(cwd, 'later') });
    await later.ready;
    expect(users).toHaveBeenCalledTimes(1);
    await Promise.all([first.release(), second.release(), later.release()]);
  });

  it('refreshes a user source once and notifies every workspace, including asset-only events', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    const file = await skill(homeDir, 'shared', 'Before');
    const users = vi.spyOn(UserSkillProvider.prototype, 'load');
    const first = session(service, options);
    const second = session(service, { ...options, cwd: otherCwd });
    await Promise.all([first.watcherReady, second.watcherReady]);
    const firstChanged = vi.fn();
    const secondChanged = vi.fn();
    first.userSkills.onDidChange(firstChanged);
    second.userSkills.onDidChange(secondChanged);
    await skill(homeDir, 'shared', 'After');
    await emit(homeDir, file);
    expect(users).toHaveBeenCalledTimes(2);
    expect(userSkill(first, 'shared')?.description).toBe('After');
    expect(userSkill(second, 'shared')?.description).toBe('After');
    expect(firstChanged).toHaveBeenCalledTimes(1);
    expect(secondChanged).toHaveBeenCalledTimes(1);
    expect(secondChanged.mock.calls[0][0]).toEqual([
      { kind: 'skill', source: 'user', path: file, operation: 'change' },
    ]);
    await emit(
      homeDir,
      join(homeDir, '.qwen', 'skills', 'shared', 'scripts', 'helper.py'),
    );
    expect(users).toHaveBeenCalledTimes(3);
    expect(secondChanged).toHaveBeenCalledTimes(2);
    await Promise.all([first.release(), second.release()]);
  });

  it('reuses user snapshots on project events and rereads them on explicit reload without notifying when suppressed', async () => {
    const { service, options, homeDir, cwd, otherCwd } = await fixture();
    await skill(homeDir, 'shared', 'Before');
    const projectFile = await skill(cwd, 'local', 'Before');
    const users = vi.spyOn(UserSkillProvider.prototype, 'load');
    const first = session(service, options);
    const second = session(service, { ...options, cwd: otherCwd });
    await Promise.all([first.watcherReady, second.watcherReady]);
    const notify = vi.fn();
    first.userSkills.onDidChange(notify);
    await skill(cwd, 'local', 'After');
    await emit(cwd, projectFile);
    expect(users).toHaveBeenCalledTimes(1);
    expect(projectSkill(first, 'local')?.description).toBe('After');
    expect(projectSkill(second, 'local')).toBeUndefined();
    notify.mockClear();
    await skill(homeDir, 'shared', 'Reloaded');
    await first.user.reloadSkills({ notify: false });
    expect(users).toHaveBeenCalledTimes(2);
    expect(userSkill(first, 'shared')?.description).toBe('Reloaded');
    expect(notify).not.toHaveBeenCalled();
    await Promise.all([first.release(), second.release()]);
  });

  it('shares user parsing across trust and source filters with one user root per service', async () => {
    const { service, options, homeDir, cwd, otherCwd } = await fixture();
    await skill(homeDir, 'shared', 'User');
    await skill(cwd, 'local', 'Project');
    const users = vi.spyOn(UserSkillProvider.prototype, 'load');
    const first = session(service, options);
    const untrusted = session(service, {
      ...options,
      cwd: otherCwd,
      isTrusted: false,
    });
    const userOnly = session(service, {
      ...options,
      skillSettings: { allowedSources: ['user'] },
    });
    const projectOnly = session(service, {
      ...options,
      skillSettings: { allowedSources: ['project'] },
    });
    await Promise.all(
      [first, untrusted, userOnly, projectOnly].map((handle) => handle.ready),
    );
    expect(users).toHaveBeenCalledTimes(1);
    expect(userSkill(untrusted, 'shared')?.source).toBe('user');
    expect(projectSkill(untrusted, 'local')).toBeUndefined();
    expect(projectSkill(userOnly, 'local')).toBeUndefined();
    expect(userSkill(projectOnly, 'shared')).toBeDefined();
    expect(projectSkill(projectOnly, 'shared')).toBeUndefined();
    const otherOptions = {
      ...options,
      globalConfigDirOverride: join(homeDir, 'other config'),
    };
    expect(() => service.getUserResource(otherOptions)).toThrow(
      /already fixed/,
    );
    const otherService = new ResourceService();
    cleanups.push(() => otherService.dispose());
    const isolated = session(otherService, otherOptions);
    await isolated.ready;
    expect(users).toHaveBeenCalledTimes(2);
    expect(userSkill(isolated, 'shared')).toBeUndefined();
    await Promise.all(
      [first, untrusted, userOnly, projectOnly, isolated].map((handle) =>
        handle.release(),
      ),
    );
  });

  it('does not let subscriber failures or reentrant reloads block other workspaces', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    const file = await skill(homeDir, 'shared', 'Before');
    const first = session(service, options);
    const second = session(service, { ...options, cwd: otherCwd });
    await Promise.all([first.watcherReady, second.watcherReady]);
    first.userSkills.onDidChange(async () => {
      await first.user.reloadSkills({ notify: false });
      throw new Error('session rejected update');
    });
    const changed = vi.fn();
    second.userSkills.onDidChange(changed);
    await skill(homeDir, 'shared', 'After');
    await emit(homeDir, file).catch(() => undefined);
    expect(changed).toHaveBeenCalled();
    expect(userSkill(second, 'shared')?.description).toBe('After');
    await Promise.all([first.release(), second.release()]);
  });

  it('stops process-owned user watchers at service shutdown', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    await skill(homeDir, 'shared', 'Before');
    const first = session(service, options);
    const second = session(service, { ...options, cwd: otherCwd });
    await Promise.all([first.watcherReady, second.watcherReady]);
    const watcher = state.watchers.find((entry) =>
      entry.requests.some(
        ({ request }) => request.path === join(homeDir, '.qwen', 'skills'),
      ),
    )!;
    await service.dispose();
    await first.release();
    expect(watcher.stopped).toBe(true);
    expect(userSkill(second, 'shared')?.description).toBe('Before');
    await second.release();
    expect(watcher.stopped).toBe(true);
    expect(registrations(join(homeDir, '.qwen', 'skills'))).toHaveLength(0);
  });

  it('recovers a failed Skill watcher while keeping the shared view', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    const file = await skill(homeDir, 'shared', 'Before');
    const first = session(service, options);
    const second = session(service, { ...options, cwd: otherCwd });
    await Promise.all([first.watcherReady, second.watcherReady]);
    const firstChanged = vi.fn();
    const secondChanged = vi.fn();
    first.userSkills.onDidChange(firstChanged);
    second.userSkills.onDidChange(secondChanged);
    const oldWatcher = state.watchers.find((entry) =>
      entry.requests.some(
        ({ request }) => request.path === join(homeDir, '.qwen', 'skills'),
      ),
    )!;
    oldWatcher.options?.onError?.(new Error('watch failed'));
    await skill(homeDir, 'shared', 'After');
    const next = session(service, options);
    const nextOther = session(service, { ...options, cwd: otherCwd });
    await Promise.all([next.watcherReady, nextOther.watcherReady]);
    // The process-owned user resource, Skill view, and project contexts stay
    // stable; existing subscribers receive the recovered snapshot too.
    expect(next.project).toBe(first.project);
    expect(nextOther.project).toBe(second.project);
    expect(next.user).toBe(first.user);
    expect(next.userSkills).toBe(first.userSkills);
    expect(userSkill(next, 'shared')?.description).toBe('After');
    expect(userSkill(first, 'shared')?.description).toBe('After');
    await vi.waitFor(() => {
      expect(firstChanged).toHaveBeenCalled();
      expect(secondChanged).toHaveBeenCalled();
    });
    oldWatcher.options?.onError?.(new Error('late error'));
    const later = session(service, options);
    expect(later.project).toBe(next.project);
    await skill(homeDir, 'shared', 'Latest');
    await emit(homeDir, file);
    expect(userSkill(first, 'shared')?.description).toBe('Latest');
    expect(userSkill(second, 'shared')?.description).toBe('Latest');
    await Promise.all(
      [first, second, next, nextOther, later].map((handle) => handle.release()),
    );
  });

  it('retains complete snapshots on user load failure and recovers on the next explicit reload', async () => {
    const { service, options, homeDir } = await fixture();
    await skill(homeDir, 'shared', 'Before');
    const first = session(service, options);
    await first.ready;
    const users = vi
      .spyOn(UserSkillProvider.prototype, 'load')
      .mockRejectedValueOnce(new Error('read failed'));
    await skill(homeDir, 'shared', 'After');
    await expect(first.user.reloadSkills()).rejects.toThrow('read failed');
    expect(userSkill(first, 'shared')?.description).toBe('Before');
    await first.user.reloadSkills();
    expect(users).toHaveBeenCalledTimes(2);
    expect(userSkill(first, 'shared')?.description).toBe('After');
    await first.release();
  });

  it('rescans a user change that arrives during an older explicit read', async () => {
    const { service, options, homeDir } = await fixture();
    const file = await skill(homeDir, 'shared', 'Before');
    const first = session(service, options);
    await first.watcherReady;
    const original = UserSkillProvider.prototype.load;
    let finishRead!: () => void;
    let scanComplete!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const scanned = new Promise<void>((resolve) => {
      scanComplete = resolve;
    });
    const users = vi
      .spyOn(UserSkillProvider.prototype, 'load')
      .mockImplementationOnce(async function (this: UserSkillProvider) {
        const snapshot = await original.call(this);
        scanComplete();
        await gate;
        return snapshot;
      });
    const reloading = first.user.reloadSkills({ notify: false });
    await scanned;
    await skill(homeDir, 'shared', 'After');
    const changing = emit(homeDir, file);
    // Let the source debounce expire while the older scan is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 350));
    finishRead();
    await Promise.all([reloading, changing]);
    expect(users).toHaveBeenCalledTimes(2);
    expect(userSkill(first, 'shared')?.description).toBe('After');
    await first.release();
  });

  it('waits for queued user reads when shutting down the process-owned source', async () => {
    const { service, options, homeDir } = await fixture();
    await skill(homeDir, 'shared', 'Before');
    const first = session(service, options);
    await first.watcherReady;
    const original = UserSkillProvider.prototype.load;
    let finishRead!: () => void;
    let scanComplete!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const scanned = new Promise<void>((resolve) => {
      scanComplete = resolve;
    });
    vi.spyOn(UserSkillProvider.prototype, 'load').mockImplementationOnce(
      async function (this: UserSkillProvider) {
        const snapshot = await original.call(this);
        scanComplete();
        await gate;
        return snapshot;
      },
    );
    const reloading = first.user.reloadSkills({ notify: false });
    await scanned;
    const watcher = state.watchers.find((entry) =>
      entry.requests.some(
        ({ request }) => request.path === join(homeDir, '.qwen', 'skills'),
      ),
    )!;
    const closing = service.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(watcher.stopped).toBe(true);
    finishRead();
    await Promise.all([reloading, closing]);
    await first.release();
    expect(watcher.stopped).toBe(true);
  });

  it('shares one process-fixed user load while retaining user precedence', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    await skill(homeDir, 'same', 'User skill');
    const compatibility = join(homeDir, '.agents', 'skills');
    await mkdir(join(compatibility, 'same'), { recursive: true });
    await mkdir(join(compatibility, 'compat-only'), { recursive: true });
    await writeFile(
      join(compatibility, 'same', 'SKILL.md'),
      '---\ndescription: Compatibility skill\n---\nBody',
    );
    await writeFile(
      join(compatibility, 'compat-only', 'SKILL.md'),
      '---\ndescription: Compatibility only\n---\nBody',
    );
    const users = vi.spyOn(UserSkillProvider.prototype, 'load');
    await service.initializeUserResources({
      homeDir,
      loadFromAgentsDirectory: true,
    });
    const first = session(service, options);
    const second = session(service, {
      ...options,
      cwd: otherCwd,
      loadFromAgentsDirectory: true,
    });
    const third = session(service, {
      ...options,
      cwd: join(otherCwd, 'third'),
      loadFromAgentsDirectory: true,
    });
    await Promise.all(
      [first, second, third].map((handle) => handle.watcherReady),
    );
    expect(users).toHaveBeenCalledTimes(1);
    expect(userSkill(first, 'compat-only')?.description).toBe(
      'Compatibility only',
    );
    // Candidates keep load order: the compatibility entry precedes the
    // selected directory, whose definition wins in the host's last-wins merge.
    expect(
      second.userSkills
        .getAllDiscoveredSkills()
        .filter((skill) => skill.name === 'same')
        .map((skill) => skill.description),
    ).toEqual(['Compatibility skill', 'User skill']);
    expect(userSkill(third, 'compat-only')?.description).toBe(
      'Compatibility only',
    );
    expect(registrations(compatibility)).toHaveLength(1);
    await Promise.all([first, second, third].map((handle) => handle.release()));
  });

  it('notifies every session when the process-enabled compatibility source changes', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    await service.initializeUserResources({
      homeDir,
      loadFromAgentsDirectory: true,
    });
    const compatibility = join(homeDir, '.agents', 'skills');
    const file = join(compatibility, 'compat', 'SKILL.md');
    await mkdir(join(compatibility, 'compat'), { recursive: true });
    await writeFile(file, '---\ndescription: Before\n---\nBody');
    const excluded = session(service, options);
    const included = session(service, {
      ...options,
      cwd: otherCwd,
      loadFromAgentsDirectory: true,
    });
    await Promise.all([excluded.watcherReady, included.watcherReady]);
    const excludedChanged = vi.fn();
    const includedChanged = vi.fn();
    excluded.userSkills.onDidChange(excludedChanged);
    included.userSkills.onDidChange(includedChanged);

    await writeFile(file, '---\ndescription: After\n---\nBody');
    await registrations(compatibility)[0].listener({
      path: file,
      operation: 'change',
    });
    await vi.waitFor(() => expect(includedChanged).toHaveBeenCalledOnce());
    expect(userSkill(included, 'compat')?.description).toBe('After');
    expect(userSkill(excluded, 'compat')?.description).toBe('After');
    expect(excludedChanged).toHaveBeenCalledOnce();
    await Promise.all([excluded.release(), included.release()]);
  });
});

async function markdown(
  root: string,
  domain: string,
  name: string,
  description: string,
) {
  const dir = join(root, '.qwen', domain);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.md`);
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n${description}`,
  );
  return file;
}

describe('process-owned user resources', () => {
  it('stops a failed user Skill watcher without waiting for sessions', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    await service.initializeUserResources(options);
    const first = session(service, options);
    const second = session(service, { ...options, cwd: otherCwd });
    await Promise.all([first.watcherReady, second.watcherReady]);
    const watcherFor = (domain: string) =>
      state.watchers.find((watcher) =>
        watcher.requests.some(
          ({ request }) => request.path === join(homeDir, '.qwen', domain),
        ),
      )!;
    const skillWatcher = watcherFor('skills');
    skillWatcher.options?.onError?.(new Error('backend failed'));
    await first.release();
    await vi.waitFor(() => expect(skillWatcher.stopped).toBe(true));
    await second.release();
    expect(skillWatcher.stopped).toBe(true);
    expect(registrations(join(homeDir, '.qwen', 'skills'))).toHaveLength(0);
  });

  it('disposes the user resource only when its service shuts down', async () => {
    const { service, options, homeDir } = await fixture();
    const dispose = vi.spyOn(UserResource.prototype, 'dispose');
    const first = session(service, options);
    await first.watcherReady;
    const watcher = state.watchers.find((watcher) =>
      watcher.requests.some(
        ({ request }) => request.path === join(homeDir, '.qwen', 'skills'),
      ),
    )!;
    watcher.options?.onError?.(new Error('backend failed'));
    const next = session(service, options);
    await next.watcherReady;
    expect(next.user).toBe(first.user);
    expect(dispose).not.toHaveBeenCalled();
    await first.release();
    await next.release();
    expect(dispose).not.toHaveBeenCalled();
    await service.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.contexts[0]).toBe(first.user);
  });

  it.each([false, true])(
    'keeps the compatibility source fixed across sessions at %s',
    async (startupCompatibility) => {
      const { service, options, homeDir, cwd } = await fixture();
      const compatibility = join(homeDir, '.agents', 'skills', 'compat');
      const projectCompatibility = join(cwd, '.agents', 'skills', 'project-compat');
      await mkdir(compatibility, { recursive: true });
      await mkdir(projectCompatibility, { recursive: true });
      await writeFile(
        join(compatibility, 'SKILL.md'),
        '---\ndescription: Compatibility\n---\nBody',
      );
      await writeFile(
        join(projectCompatibility, 'SKILL.md'),
        '---\ndescription: Project compatibility\n---\nBody',
      );
      const agents = vi.spyOn(UserAgentProvider.prototype, 'load');
      await service.initializeUserResources({
        homeDir,
        loadFromAgentsDirectory: startupCompatibility,
      });
      const first = session(service, {
        ...options,
        loadFromAgentsDirectory: true,
      });
      const second = session(service, {
        ...options,
        loadFromAgentsDirectory: false,
      });
      await Promise.all([first.watcherReady, second.watcherReady]);
      expect(userSkill(first, 'compat')?.description).toBe(
        startupCompatibility ? 'Compatibility' : undefined,
      );
      expect(userSkill(second, 'compat')?.description).toBe(
        startupCompatibility ? 'Compatibility' : undefined,
      );
      expect(
        first.project.skills
          .getAllDiscoveredSkills()
          .find((skill) => skill.name === 'project-compat')?.description,
      ).toBe('Project compatibility');
      expect(
        second.project.skills
          .getAllDiscoveredSkills()
          .find((skill) => skill.name === 'project-compat'),
      ).toBeUndefined();
      expect(agents).toHaveBeenCalledTimes(1);
      expect(registrations(join(homeDir, '.agents', 'skills'))).toHaveLength(
        startupCompatibility ? 1 : 0,
      );
      await Promise.all([first.release(), second.release()]);
    },
  );

  it('keeps an explicit project OutputStyle directory on user events and restores the workspace on explicit reload', async () => {
    const { service, options, homeDir, cwd, otherCwd } = await fixture();
    await markdown(
      homeDir,
      'output-styles',
      'global',
      'Before',
    );
    await markdown(cwd, 'output-styles', 'local', 'Workspace');
    await markdown(otherCwd, 'output-styles', 'local', 'Override');
    const handle = session(service, options);
    await handle.watcherReady;
    await handle.project.reloadOutputStyles({
      projectConfigDirOverride: join(otherCwd, '.qwen'),
    });
    await markdown(
      otherCwd,
      'output-styles',
      'local',
      'Unloaded project change',
    );
    await markdown(homeDir, 'output-styles', 'global', 'After');
    await handle.user.reloadOutputStyles();
    expect(
      handle.user.outputStyles
        .getAllDiscoveredOutputStyles()
        .find((style) => style.name === 'global')?.prompt,
    ).toBe('After');
    expect(
      handle.project.outputStyles
        .getAllDiscoveredOutputStyles()
        .find((style) => style.name === 'local')?.prompt,
    ).toBe('Override');
    await handle.project.reloadOutputStyles();
    expect(
      handle.project.outputStyles
        .getAllDiscoveredOutputStyles()
        .find((style) => style.name === 'local')?.prompt,
    ).toBe('Workspace');
    await handle.release();
  });

  it('loads all user domains at startup once before any workspace, and reuses them across cwds', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    await Promise.all([
      skill(homeDir, 'shared', 'User skill'),
      markdown(homeDir, 'agents', 'shared', 'User agent'),
      markdown(homeDir, 'output-styles', 'shared', 'User style'),
    ]);
    const skills = vi.spyOn(UserSkillProvider.prototype, 'load');
    const agents = vi.spyOn(UserAgentProvider.prototype, 'load');
    const styles = vi.spyOn(OutputStyleProvider.prototype, 'load');
    const projects = vi.spyOn(ProjectSkillProvider.prototype, 'load');
    await Promise.all([
      service.initializeUserResources({ homeDir }),
      service.initializeUserResources({ homeDir }),
    ]);
    expect(skills).toHaveBeenCalledTimes(1);
    expect(agents).toHaveBeenCalledTimes(1);
    expect(styles).toHaveBeenCalledTimes(1);
    expect(projects).not.toHaveBeenCalled();
    const first = session(service, options);
    const second = session(service, {
      ...options,
      cwd: otherCwd,
      isTrusted: false,
    });
    try {
      await Promise.all([first.watcherReady, second.watcherReady]);
      expect(skills).toHaveBeenCalledTimes(1);
      expect(agents).toHaveBeenCalledTimes(1);
      expect(
        styles.mock.contexts.filter(
          (provider) =>
            provider instanceof OutputStyleProvider &&
            provider.source === 'userSettings',
        ),
      ).toHaveLength(1);
      for (const handle of [first, second]) {
        expect(
          handle.user.agents
            .getAllDiscoveredAgents()
            .find((agent) => agent.name === 'shared')?.description,
        ).toBe('User agent');
        expect(
          handle.user.outputStyles
            .getAllDiscoveredOutputStyles()
            .find((style) => style.name === 'shared')?.prompt,
        ).toBe('User style');
      }
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });

  it.each([false, true])(
    'fixes one user root and rejects mismatching paths (eager=%s)',
    async (eager) => {
      const { service, options, homeDir, otherCwd } = await fixture();
      if (eager) {
        await service.initializeUserResources(options);
      } else {
        await service.getUserResource(options).ready;
      }
      // Explicit paths and equivalent relative segments refer to the same root.
      await service.initializeUserResources({
        ...options,
        globalConfigDirOverride: join(homeDir, '.qwen', 'nested', '..'),
        userAgentSkillsDirOverride: join(homeDir, '.agents', 'skills'),
      });
      for (const overrides of [
        { globalConfigDirOverride: join(otherCwd, 'config') },
        { userAgentSkillsDirOverride: join(otherCwd, 'skills') },
      ]) {
        await expect(
          service.initializeUserResources({ ...options, ...overrides }),
        ).rejects.toThrow(/already fixed/);
        expect(() =>
          service.getUserResource({ ...options, ...overrides }),
        ).toThrow(/already fixed/);
      }
      await service.dispose();
      await expect(service.initializeUserResources(options)).rejects.toThrow(
        /disposed/,
      );
    },
  );

  it('recovers the startup Skill source using the captured user options', async () => {
    const { service, options, homeDir, otherCwd } = await fixture();
    await markdown(homeDir, 'agents', 'shared', 'User');
    const startupOptions = { ...options, loadFromAgentsDirectory: true };
    await service.initializeUserResources(startupOptions);
    // The caller's settings object may change after startup.
    startupOptions.homeDir = otherCwd;
    startupOptions.loadFromAgentsDirectory = false;
    const first = session(service, options);
    await first.watcherReady;
    const watcher = state.watchers.find((watcher) =>
      watcher.requests.some(
        ({ request }) => request.path === join(homeDir, '.qwen', 'skills'),
      ),
    )!;
    watcher.options?.onError?.(new Error('backend failed'));
    const next = session(service, {
      ...options,
      cwd: otherCwd,
      loadFromAgentsDirectory: false,
    });
    try {
      await next.watcherReady;
      await service.initializeUserResources({
        ...options,
        loadFromAgentsDirectory: false,
      });
      expect(
        next.user.agents
          .getAllDiscoveredAgents()
          .find((agent) => agent.name === 'shared')?.description,
      ).toBe('User');
      // Rewarming retains the process's original compatibility directory even
      // though this workspace and the repeated initializer disable it.
      expect(registrations(join(homeDir, '.agents', 'skills'))).toHaveLength(1);
    } finally {
      await Promise.all([first.release(), next.release()]);
    }
  });

  it('retries startup loading after a transient provider failure', async () => {
    const { service, options } = await fixture();
    vi.spyOn(UserAgentProvider.prototype, 'load').mockRejectedValueOnce(
      new Error('transient read'),
    );
    await expect(service.initializeUserResources(options)).rejects.toThrow(
      'transient read',
    );
    await expect(
      service.initializeUserResources(options),
    ).resolves.toBeUndefined();
  });

  it('keeps shared user Agents and OutputStyles stable until explicit reload', async () => {
    const { service, options, homeDir, cwd, otherCwd } = await fixture();
    await markdown(homeDir, 'agents', 'shared', 'Before');
    await markdown(homeDir, 'output-styles', 'shared', 'Before');
    await markdown(cwd, 'agents', 'shared', 'Project');
    const agents = vi.spyOn(UserAgentProvider.prototype, 'load');
    const styles = vi.spyOn(OutputStyleProvider.prototype, 'load');
    const first = session(service, options);
    const second = session(service, { ...options, cwd: otherCwd });
    try {
      await Promise.all([first.ready, second.ready]);
      expect(first.user).toBe(second.user);
      expect(agents).toHaveBeenCalledTimes(1);
      expect(styles.mock.contexts.filter((provider) =>
        provider instanceof OutputStyleProvider && provider.source === 'userSettings',
      )).toHaveLength(1);
      expect(registrations(join(homeDir, '.qwen', 'agents'))).toHaveLength(0);
      expect(registrations(join(homeDir, '.qwen', 'output-styles'))).toHaveLength(0);

      await markdown(homeDir, 'agents', 'shared', 'After');
      await markdown(homeDir, 'output-styles', 'shared', 'After');
      expect(first.user.agents.getAllDiscoveredAgents()[0].description).toBe('Before');
      expect(second.user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe('Before');
      await Promise.all([first.user.reloadAgents(), first.user.reloadOutputStyles()]);
      expect(second.user.agents.getAllDiscoveredAgents()[0].description).toBe('After');
      expect(second.user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe('After');
      expect(first.project.agents.getAllDiscoveredAgents()[0].description).toBe('Project');
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });

});
