/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  FileChangeEvent,
  FileChangeListener,
  FileWatcher,
  WatchRequest,
} from '../../file-watcher/fileWatcher.js';
import { FileSystemWatcher } from '../../file-watcher/fileWatcher.js';
import { ProjectResource } from './projectResource.js';
import { UserResource } from './userResource.js';
import type { SkillDefinition } from '../kinds/skills/types.js';
import { ProjectAgentProvider } from '../kinds/agents/providers/projectAgentProvider.js';

function createTestFileWatcher(): FileSystemWatcher {
  const watcher = new FileSystemWatcher({
    debounceMs: 50,
    awaitWriteFinish: false,
    usePolling: true,
    pollingIntervalMs: 100,
  });
  vi.spyOn(watcher, 'start');
  return watcher;
}

async function waitForWatching(watcher: FileWatcher): Promise<void> {
  await vi.waitFor(() => expect(watcher.start).toHaveBeenCalled());
  await vi.mocked(watcher.start).mock.results[0].value;
}

class RecordingFileWatcher implements FileWatcher {
  readonly isNoop = false;
  readonly paths: string[] = [];
  readonly requests: WatchRequest[] = [];
  private readonly listeners = new Map<string, FileChangeListener>();

  watch(request: WatchRequest, listener: FileChangeListener): () => void {
    this.paths.push(request.path);
    this.requests.push(request);
    this.listeners.set(request.path, listener);
    return () => this.listeners.delete(request.path);
  }

  start = vi.fn(async (): Promise<void> => {});
  async stop(): Promise<void> {}

  isWatching(path: string): boolean {
    return this.listeners.has(path);
  }

  async emit(
    path: string,
    operation: FileChangeEvent['operation'],
  ): Promise<void> {
    await Promise.all(
      [...this.listeners].map(async ([watchedPath, listener]) => {
        if (path === watchedPath || path.startsWith(watchedPath + '/')) {
          await listener({ path, operation });
        }
      }),
    );
  }
}

async function writeSkill(
  skillsDir: string,
  name: string,
  description = name,
): Promise<void> {
  const directory = join(skillsDir, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\ndescription: ${description}\n---\n${description}`,
  );
}

async function writeAgent(
  agentsDir: string,
  name: string,
  body = name,
): Promise<string> {
  await mkdir(agentsDir, { recursive: true });
  const file = join(agentsDir, `${name}.md`);
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${name}\n---\n${body}`,
  );
  return file;
}

function findSkill(skills: readonly SkillDefinition[], name: string) {
  return skills.find(
    (skill) => skill.name.toLowerCase() === name.toLowerCase(),
  );
}

/** Creates the user scope for direct-construction fixtures. */
async function createUserScope(
  home: string,
  options: { loadFromAgentsDirectory?: boolean } = {},
): Promise<{ user: UserResource; skills: UserResource['skills'] }> {
  const user = new UserResource({ homeDir: home, ...options });
  const skills = user.skills;
  await Promise.all([user.initialize(), skills.ready]);
  return { user, skills };
}

describe('ProjectResource', () => {
  it('does not run queued Agent refreshes or commit an in-flight read after disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const cwd = join(root, 'repo');
    await writeAgent(join(cwd, '.qwen', 'agents'), 'sample', 'Before');
    const project = new ProjectResource({ cwd, homeDir: join(root, 'home'), isTrusted: true });
    let finishRead!: (value: Awaited<ReturnType<ProjectAgentProvider['load']>>) => void;
    try {
      await project.ready;
      const load = vi.spyOn(ProjectAgentProvider.prototype, 'load').mockImplementationOnce(
        () => new Promise((resolve) => { finishRead = resolve; }),
      );
      const first = project.reloadAgents();
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      const queued = project.reloadAgents();
      const disposal = project.dispose();
      finishRead({ source: 'project', agents: [], loadErrors: [] });
      await expect(first).rejects.toThrow('disposed');
      await expect(queued).rejects.toThrow('disposed');
      await disposal;
      expect(load).toHaveBeenCalledOnce();
      expect(project.agents.getAllDiscoveredAgents()[0].prompt).toBe('Before');
    } finally {
      vi.restoreAllMocks();
      await project.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes initial snapshots without waiting for the watcher to become ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'project-skill');

    let resolveWatcherStart!: () => void;
    const watcherStart = new Promise<void>((resolve) => {
      resolveWatcherStart = resolve;
    });
    const fileWatcher = new RecordingFileWatcher();
    fileWatcher.start.mockImplementation(() => watcherStart);
    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
      fileWatcher,
    });

    await project.ready;

    expect(fileWatcher.start).not.toHaveBeenCalled();
    expect(
      findSkill(project.skills.getAllDiscoveredSkills(), 'project-skill'),
    ).toBeDefined();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fileWatcher.start).toHaveBeenCalledOnce();

    let watcherReady = false;
    void project.watcherReady.then(() => {
      watcherReady = true;
    });
    await Promise.resolve();
    expect(watcherReady).toBe(false);

    resolveWatcherStart();
    await expect(project.watcherReady).resolves.toBeUndefined();
    await project.dispose();
  });

  it('keeps completed snapshots when background watcher startup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'project-skill');

    const startupError = Object.assign(new Error('watcher timed out'), {
      code: 'ETIMEDOUT',
    });
    const fileWatcher = new RecordingFileWatcher();
    fileWatcher.start.mockRejectedValue(startupError);
    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
      fileWatcher,
    });

    await expect(project.ready).resolves.toBeUndefined();
    await expect(project.watcherReady).rejects.toBe(startupError);
    expect(
      findSkill(project.skills.getAllDiscoveredSkills(), 'project-skill'),
    ).toBeDefined();

    await project.dispose();
  });

  it('loads Agent resources without watchers and publishes explicit reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const additional = join(root, 'extra');
    const projectFile = await writeAgent(
      join(cwd, '.qwen', 'agents'),
      'project-agent',
      'version one',
    );
    await writeAgent(join(additional, '.qwen', 'agents'), 'additional-agent');
    const fileWatcher = new RecordingFileWatcher();
    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
      additionalDirectories: [additional],
      fileWatcher,
    });
    await project.ready;
    await waitForWatching(fileWatcher);

    expect(
      project.agents
        .getAllDiscoveredAgents()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['project-agent']);
    expect(fileWatcher.paths).not.toContain(join(home, '.qwen', 'agents'));
    expect(fileWatcher.paths).not.toContain(join(cwd, '.qwen', 'agents'));

    await writeAgent(
      join(cwd, '.qwen', 'agents'),
      'project-agent',
      'version two',
    );
    await fileWatcher.emit(projectFile, 'change');

    expect(project.agents.getAllDiscoveredAgents()[0].prompt).toBe(
      'version one',
    );
    await project.reloadAgents();

    expect(project.agents.getAllDiscoveredAgents()[0].prompt).toBe(
      'version two',
    );

    const returned = project.agents.getAllDiscoveredAgents()[0];
    returned!.prompt = 'mutated';
    returned!.metadata.source = 'user';
    expect(project.agents.getAllDiscoveredAgents()[0]).toMatchObject({
      prompt: 'version two',
      metadata: { source: 'project' },
    });
    expect(project.skills.getAllDiscoveredSkills()).toEqual([]);
    await project.dispose();
  });

  it('loads project and additional Skill roots and watches only project targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const additionalRoot = join(root, 'extra');
    const { user, skills: userSkills } = await createUserScope(home);
    await writeSkill(join(home, '.qwen', 'skills'), 'user-skill');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'project-skill');
    await writeSkill(
      join(additionalRoot, '.qwen', 'skills'),
      'additional-skill',
    );
    await mkdir(join(home, '.qwen'), { recursive: true });
    await writeFile(join(home, '.qwen', 'settings.json'), '{"theme":"dark"}');

    const fileWatcher = new RecordingFileWatcher();
    const project = new ProjectResource({
      cwd,
      homeDir: home,
      additionalDirectories: [additionalRoot],
      isTrusted: true,
      fileWatcher,
    });
    await project.ready;
    await waitForWatching(fileWatcher);
    await user.reloadSkills({ notify: false });

    expect(
      project.skills
        .getAllDiscoveredSkills()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['additional-skill', 'project-skill']);
    expect(
      userSkills
        .getAllDiscoveredSkills()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['user-skill']);
    for (const request of fileWatcher.requests) {
      expect(request.depth).toBe(2);
      expect(request.preferNativeRecursive).toBe(true);
      expect(request.ignoredDirectoryNames).toEqual(['node_modules', '.git']);
    }
    expect(fileWatcher.paths).toEqual(
      expect.arrayContaining([
        join(cwd, '.qwen', 'skills'),
        join(cwd, '.qwen', 'commands'),
        join(additionalRoot, '.qwen', 'skills'),
        join(additionalRoot, '.qwen', 'commands'),
      ]),
    );
    expect(fileWatcher.paths).not.toContain(join(home, '.qwen', 'skills'));
    expect(fileWatcher.paths).not.toContain(
      join(home, '.qwen', 'settings.json'),
    );
    await project.dispose();
    await user.dispose();
  });

  it('keeps user and project Skill candidates independent per scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-scope-split-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const { user, skills: userSkills } = await createUserScope(home);
    await writeSkill(join(home, '.qwen', 'skills'), 'same', 'User');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'same', 'Project');
    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
    });
    await project.ready;
    await user.reloadSkills({ notify: false });

    expect(
      project.skills.getAllDiscoveredSkills().map((item) => item.description),
    ).toEqual(['Project']);
    expect(
      userSkills.getAllDiscoveredSkills().map((item) => item.description),
    ).toEqual(['User']);
    await project.dispose();
    await user.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('loads .agents compatibility skills only when explicitly enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeSkill(join(cwd, '.agents', 'skills'), 'legacy');

    const disabled = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
    });
    await disabled.ready;
    expect(disabled.skills.getAllDiscoveredSkills()).toEqual([]);
    await disabled.dispose();

    const enabled = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
      loadFromAgentsDirectory: true,
    });
    await enabled.ready;
    expect(enabled.skills.getAllDiscoveredSkills()[0].source).toBe('project');
    await enabled.dispose();
  });

  it('deduplicates selected and compatibility directories when both are .agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeSkill(join(cwd, '.agents', 'skills'), 'project-skill');

    const project = new ProjectResource({
      cwd,
      homeDir: home,
      configDirName: '.agents',
      isTrusted: true,
      loadFromAgentsDirectory: true,
    });
    await project.ready;

    expect(project.skills.getAllDiscoveredSkills()).toHaveLength(1);
    expect(project.skills.getAllDiscoveredSkills()[0].source).toBe('project');
    await project.dispose();
  });

  it('reloads the static snapshot after trust changes without owning session state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'project-skill');

    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: false,
    });
    await project.ready;
    expect(project.skills.getAllDiscoveredSkills()).toEqual([]);

    await project.updateWorkspaceContext({
      isTrusted: true,
      additionalDirectories: [],
    });
    await project.reloadSkills({ notify: false });
    expect(
      project.skills
        .getAllDiscoveredSkills()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['project-skill']);
    await project.dispose();
  });

  it('loads and watches additional directories added at runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const additionalRoot = join(root, 'extra');
    const additionalSkillsDir = join(additionalRoot, '.qwen', 'skills');
    const additionalSkillFile = join(
      additionalSkillsDir,
      'runtime-skill',
      'SKILL.md',
    );
    await mkdir(cwd, { recursive: true });
    await writeSkill(additionalSkillsDir, 'runtime-skill', 'version one');

    const fileWatcher = new RecordingFileWatcher();
    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
      fileWatcher,
    });
    await project.ready;
    await waitForWatching(fileWatcher);
    expect(project.skills.getAllDiscoveredSkills()).toEqual([]);

    await project.updateWorkspaceContext({
      isTrusted: true,
      additionalDirectories: [additionalRoot],
    });
    await project.reloadSkills({ notify: false });

    expect(
      findSkill(project.skills.getAllDiscoveredSkills(), 'runtime-skill')?.body,
    ).toBe('version one');
    expect(fileWatcher.isWatching(additionalSkillsDir)).toBe(true);

    const changed = vi.fn();
    project.skills.onDidChange(changed);
    await writeSkill(additionalSkillsDir, 'runtime-skill', 'version two');
    await fileWatcher.emit(additionalSkillFile, 'change');

    expect(changed).toHaveBeenCalledOnce();
    expect(
      findSkill(project.skills.getAllDiscoveredSkills(), 'runtime-skill')?.body,
    ).toBe('version two');

    await project.updateWorkspaceContext({
      isTrusted: true,
      additionalDirectories: [],
    });
    await project.reloadSkills({ notify: false });

    expect(project.skills.getAllDiscoveredSkills()).toEqual([]);
    expect(fileWatcher.isWatching(additionalSkillsDir)).toBe(false);
    await project.dispose();
  });

  it('refreshes the Skill snapshot before publishing file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'alpha');

    const fileWatcher = createTestFileWatcher();
    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
      fileWatcher,
    });
    await project.ready;
    await waitForWatching(fileWatcher);

    const observedSnapshots: string[][] = [];
    const changes = vi.fn();
    project.skills.onDidChange(changes);
    project.skills.onDidChange(() => {
      observedSnapshots.push(
        project.skills
          .getAllDiscoveredSkills()
          .map((item) => item.name)
          .sort(),
      );
    });
    await writeSkill(join(cwd, '.qwen', 'skills'), 'beta');

    await vi.waitFor(
      () => expect(observedSnapshots).toContainEqual(['alpha', 'beta']),
      { timeout: 9000, interval: 100 },
    );
    expect(changes).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill',
          path: expect.stringContaining('beta'),
        }),
      ]),
      expect.objectContaining({ discoveredSkills: expect.any(Array) }),
    );
    changes.mockClear();
    await project.reloadSkills();
    expect(changes).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.objectContaining({ discoveredSkills: expect.any(Array) }),
    );
    await project.dispose();
  });

  it('isolates file events between Skill subscribers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-event-copies-test-'));
    const skillsDir = join(root, '.qwen', 'skills');
    await writeSkill(skillsDir, 'example');
    const watcher = new RecordingFileWatcher();
    const project = new ProjectResource({
      cwd: root,
      homeDir: join(root, 'home'),
      isTrusted: true,
      fileWatcher: watcher,
    });
    await project.ready;
    await project.watcherReady;
    project.skills.onDidChange((events) => {
      events![0].path = 'subscriber-local mutation';
    });
    const otherSubscriber = vi.fn();
    project.skills.onDidChange(otherSubscriber);
    const filePath = join(skillsDir, 'example', 'SKILL.md');
    try {
      await watcher.emit(filePath, 'change');
      expect(otherSubscriber).toHaveBeenCalledExactlyOnceWith(
        [expect.objectContaining({ path: filePath })],
        expect.objectContaining({ discoveredSkills: expect.any(Array) }),
      );
    } finally {
      await project.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows a Skill listener to await another reload and retains its candidate snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-reentrant-test-'));
    const cwd = join(root, 'repo');
    const skillsDir = join(cwd, '.qwen', 'skills');
    await writeSkill(skillsDir, 'example', 'Before');
    const project = new ProjectResource({
      cwd,
      homeDir: join(root, 'home'),
      isTrusted: true,
      fileWatcher: new RecordingFileWatcher(),
    });
    await project.ready;
    const otherSubscriber = vi.fn();
    project.skills.onDidChange(async (_events, snapshot) => {
      await writeSkill(skillsDir, 'example', 'After');
      await project.reloadSkills({ notify: false });
      expect(snapshot?.discoveredSkills[0].description).toBe('Before');
      expect(
        findSkill(project.skills.getAllDiscoveredSkills(), 'example')
          ?.description,
      ).toBe('After');
      snapshot!.discoveredSkills[0].description = 'subscriber-local mutation';
    });
    project.skills.onDidChange(otherSubscriber);
    try {
      await project.reloadSkills();
      expect(otherSubscriber).toHaveBeenCalledExactlyOnceWith(
        undefined,
        expect.objectContaining({
          discoveredSkills: [
            expect.objectContaining({ description: 'Before' }),
          ],
        }),
      );
    } finally {
      await project.dispose();
    }
  });

  it('permits newer Skill reads during slow notifications and waits for them on dispose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-notifications-test-'));
    const cwd = join(root, 'repo');
    const skillsDir = join(cwd, '.qwen', 'skills');
    await writeSkill(skillsDir, 'example', 'Before');
    const project = new ProjectResource({
      cwd,
      homeDir: join(root, 'home'),
      isTrusted: true,
      fileWatcher: new RecordingFileWatcher(),
    });
    await project.ready;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: string[] = [];
    project.skills.onDidChange(async (_events, snapshot) => {
      const description = snapshot!.discoveredSkills[0].description;
      received.push(description);
      if (description === 'Before') await blocker;
      expect(snapshot!.discoveredSkills[0].description).toBe(description);
    });
    const first = project.reloadSkills();
    await vi.waitFor(() => expect(received).toEqual(['Before']));
    try {
      await writeSkill(skillsDir, 'example', 'After');
      await project.reloadSkills();
      expect(received).toEqual(['Before', 'After']);
      let disposed = false;
      const disposal = project.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);
      release();
      await first;
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      release();
      await first;
      await project.dispose();
    }
  });

  it('propagates listener failures to reload callers without rejecting dispose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-dispose-error-test-'));
    const project = new ProjectResource({
      cwd: root,
      homeDir: join(root, 'home'),
      fileWatcher: new RecordingFileWatcher(),
    });
    await project.ready;
    let reject!: (error: Error) => void;
    const blocker = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const listener = vi.fn(() => blocker);
    project.skills.onDidChange(listener);
    const error = new Error('subscriber failed');
    const reload = project.reloadSkills().catch((failure) => failure);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    const disposal = project.dispose().catch((failure) => failure);
    try {
      // Let disposal reach its wait for the in-flight notification.
      await new Promise<void>((resolve) => setImmediate(resolve));
      reject(error);
      expect(await reload).toBe(error);
      expect(await disposal).toBeUndefined();
    } finally {
      reject(error);
      await reload.catch(() => undefined);
      await disposal.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for other Skill listeners when one subscriber fails during disposal', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'resource-dispose-listeners-test-'),
    );
    const project = new ProjectResource({
      cwd: root,
      homeDir: join(root, 'home'),
      fileWatcher: new RecordingFileWatcher(),
    });
    await project.ready;
    let reject!: (error: Error) => void;
    let release!: () => void;
    const failing = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failedListener = vi.fn(() => failing);
    const slowListener = vi.fn(() => slow);
    project.skills.onDidChange(failedListener);
    project.skills.onDidChange(slowListener);
    const error = new Error('subscriber failed');
    const reload = project.reloadSkills().catch((failure) => failure);
    await vi.waitFor(() => expect(slowListener).toHaveBeenCalledOnce());
    let disposed = false;
    const disposal = project.dispose().then(() => {
      disposed = true;
    });
    try {
      reject(error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);
      release();
      expect(await reload).toBe(error);
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      reject(error);
      release();
      await Promise.allSettled([reload, disposal]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects new Skill reloads from in-flight listeners once disposal starts', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'resource-dispose-reload-test-'),
    );
    const project = new ProjectResource({
      cwd: root,
      homeDir: join(root, 'home'),
      fileWatcher: new RecordingFileWatcher(),
    });
    await project.ready;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listener = vi.fn(async () => {
      await blocker;
      await expect(project.reloadSkills({ notify: false })).rejects.toThrow(
        'ProjectResource is disposed',
      );
    });
    project.skills.onDidChange(listener);
    const reload = project.reloadSkills();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    const disposal = project.dispose();
    try {
      release();
      await Promise.all([reload, disposal]);
      await expect(project.reloadSkills()).rejects.toThrow(
        'ProjectResource is disposed',
      );
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.allSettled([reload, disposal]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes compatibility skills when a project .agents symlink is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const realAgents = join(root, 'real-agents');
    await mkdir(cwd, { recursive: true });
    await writeSkill(join(realAgents, 'skills'), 'legacy');
    await symlink(realAgents, join(cwd, '.agents'));

    const fileWatcher = createTestFileWatcher();
    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
      loadFromAgentsDirectory: true,
      fileWatcher,
    });
    await project.ready;
    await waitForWatching(fileWatcher);
    expect(
      findSkill(project.skills.getAllDiscoveredSkills(), 'legacy'),
    ).toBeDefined();

    await unlink(join(cwd, '.agents'));
    await vi.waitFor(
      () =>
        expect(
          findSkill(project.skills.getAllDiscoveredSkills(), 'legacy'),
        ).toBeUndefined(),
      { timeout: 9000, interval: 100 },
    );
    await project.dispose();
  });

  it('publishes copied Skill snapshots that consumers cannot mutate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'review');

    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
    });
    await project.ready;

    const returned = project.skills.getAllDiscoveredSkills()[0];
    returned.name = 'changed';
    returned.allowedTools?.push('Write');
    returned.body = 'mutated';

    expect(project.skills.getAllDiscoveredSkills()[0]).toMatchObject({
      name: 'review',
      body: 'review',
    });
    await project.dispose();
  });

  it('notifies for Skill reloads while Agent reloads remain explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'review');
    await writeAgent(join(cwd, '.qwen', 'agents'), 'reviewer');

    const project = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: true,
    });
    const skillListener = vi.fn();
    project.skills.onDidChange(skillListener);
    await project.ready;

    expect(skillListener).not.toHaveBeenCalled();

    await project.reloadSkills();
    expect(skillListener).toHaveBeenCalledOnce();

    await project.reloadSkills({ notify: false });
    expect(skillListener).toHaveBeenCalledOnce();

    await project.reloadAgents();
    expect(skillListener).toHaveBeenCalledOnce();
    await project.dispose();
  });

  it('skips the project directory when untrusted or cwd is home while additional roots stay trusted-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-gates-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const additionalRoot = join(root, 'extra');
    await writeSkill(join(cwd, '.qwen', 'skills'), 'project-skill');
    await writeSkill(join(additionalRoot, '.qwen', 'skills'), 'additional');

    const untrusted = new ProjectResource({
      cwd,
      homeDir: home,
      additionalDirectories: [additionalRoot],
      isTrusted: false,
    });
    await untrusted.ready;
    expect(untrusted.skills.getAllDiscoveredSkills()).toEqual([]);
    await untrusted.dispose();

    const homeCwd = new ProjectResource({
      cwd: home,
      homeDir: home,
      additionalDirectories: [additionalRoot],
      isTrusted: true,
    });
    await homeCwd.ready;
    // cwd == home skips the project directory but additional roots still load.
    expect(
      homeCwd.skills
        .getAllDiscoveredSkills()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(['additional']);
    await homeCwd.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('reloads project agents only when trusted and not in the home directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-agent-gates-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    await writeAgent(join(cwd, '.qwen', 'agents'), 'project-agent');

    const untrusted = new ProjectResource({
      cwd,
      homeDir: home,
      isTrusted: false,
    });
    await untrusted.ready;
    expect(untrusted.agents.getAllDiscoveredAgents()).toEqual([]);
    await untrusted.dispose();

    const homeCwd = new ProjectResource({
      cwd: home,
      homeDir: home,
      isTrusted: true,
    });
    await homeCwd.ready;
    expect(homeCwd.agents.getAllDiscoveredAgents()).toEqual([]);
    await homeCwd.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
