/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ResourceService } from '../core/resourceService.js';
import {
  ProjectResource,
  type ProjectResourceOptions,
} from '../core/projectResource.js';
import { FileSystemWatcher } from '../../file-watcher/fileWatcher.js';
import type { UserResourceOptions } from '../core/userResource.js';

/** Mimics a session: process user resource, Skill view and project handle. */
function session(
  service: ResourceService,
  options: ProjectResourceOptions & UserResourceOptions,
) {
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

it('shares live resources and invalidates future acquisitions with real watchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-resource-integration-'));
  const cwd = join(root, '中文 workspace');
  const homeDir = join(root, 'home');
  const skillsDir = join(cwd, '.qwen', 'skills', 'example');
  const agentsDir = join(cwd, '.qwen', 'agents');
  await mkdir(skillsDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const skillFile = join(skillsDir, 'SKILL.md');
  await writeFile(
    skillFile,
    '---\nname: example\ndescription: First\n---\nFirst',
  );
  const service = new ResourceService();
  const options = {
    cwd,
    homeDir,
    isTrusted: true,
  };
  const first = service.getProjectResource(options);
  const description = () =>
    first.project.skills
      .getAllDiscoveredSkills()
      .find((skill) => skill.name === 'example')?.description;
  try {
    await first.ready;
    await first.watcherReady;
    const second = service.getProjectResource(options);
    expect(second.project).toBe(first.project);
    await writeFile(
      skillFile,
      '---\nname: example\ndescription: Second\n---\nSecond',
    );
    await expect.poll(() => description(), { timeout: 10000 }).toBe('Second');
    await first.release();
    await writeFile(
      skillFile,
      '---\nname: example\ndescription: Third\n---\nThird',
    );
    await expect.poll(() => description(), { timeout: 10000 }).toBe('Third');
    await writeFile(
      join(agentsDir, 'new-agent.md'),
      '---\nname: new-agent\ndescription: New agent\n---\nInstructions',
    );
    await expect
      .poll(
        () => {
          const next = service.getProjectResource(options);
          const replaced = next.project !== second.project;
          void next.release();
          return replaced;
        },
        { timeout: 10000 },
      )
      .toBe(true);
    expect(
      second.project.agents
        .getAllDiscoveredAgents()
        .some((agent) => agent.name === 'new-agent'),
    ).toBe(false);
    await second.release();
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('shares user Skills and Commands across different cwd contexts with real watchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-user-integration-'));
  const homeDir = join(root, '用户 home');
  const cwdA = join(root, '项目 A');
  const cwdB = join(root, '项目 B');
  const skillsDir = join(homeDir, '.qwen', 'skills', 'shared');
  const commandsDir = join(homeDir, '.qwen', 'commands');
  const service = new ResourceService();
  const handles: Array<ReturnType<typeof session>> = [];
  try {
    await Promise.all(
      [skillsDir, commandsDir, cwdA, cwdB].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    const skillFile = join(skillsDir, 'SKILL.md');
    const commandFile = join(commandsDir, 'hello.md');
    await writeFile(skillFile, '---\ndescription: Initial skill\n---\nBody');
    await writeFile(
      commandFile,
      '---\ndescription: Initial command\n---\nBody',
    );
    const first = session(service, {
      homeDir,
      cwd: cwdA,
      isTrusted: true,
    });
    const second = session(service, {
      homeDir,
      cwd: cwdB,
      isTrusted: true,
    });
    handles.push(first, second);
    await Promise.all(handles.map((handle) => handle.watcherReady));
    expect(first.project).not.toBe(second.project);
    expect(first.user).toBe(second.user);
    const userSkill = (handle: (typeof handles)[number], name: string) =>
      handle.userSkills
        .getAllDiscoveredSkills()
        .find((skill) => skill.name === name)?.description;
    for (const handle of handles) {
      expect(userSkill(handle, 'shared')).toBe('Initial skill');
      expect(userSkill(handle, 'hello')).toBe('Initial command');
    }
    await writeFile(skillFile, '---\ndescription: Updated skill\n---\nBody');
    await expect
      .poll(() => handles.map((handle) => userSkill(handle, 'shared')), {
        timeout: 10000,
      })
      .toEqual(['Updated skill', 'Updated skill']);
    // User watchers belong to the service, not the remaining session.
    await service.dispose();
    await first.release();
    await writeFile(
      commandFile,
      '---\ndescription: Updated command\n---\nBody',
    );
    expect(userSkill(second, 'hello')).toBe('Initial command');
  } finally {
    await service.dispose();
    await Promise.all(handles.map((handle) => handle.release()));
    await rm(root, { recursive: true, force: true });
  }
});

it('shares user Agents and OutputStyles until explicit reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-user-domains-'));
  const homeDir = join(root, '用户 home');
  const cwdA = join(root, '项目 A');
  const cwdB = join(root, '项目 B');
  const service = new ResourceService();
  const handles: Array<ReturnType<typeof session>> = [];
  try {
    await Promise.all(
      [homeDir, cwdA, cwdB].map((dir) => mkdir(dir, { recursive: true })),
    );
    await service.initializeUserResources({ homeDir });
    handles.push(
      session(service, { homeDir, cwd: cwdA }),
      session(service, { homeDir, cwd: cwdB }),
    );
    await Promise.all(handles.map((handle) => handle.ready));
    const agentDir = join(homeDir, '.qwen', 'agents');
    const styleDir = join(homeDir, '.qwen', 'output-styles');
    await Promise.all(
      [agentDir, styleDir].map((dir) => mkdir(dir, { recursive: true })),
    );
    await writeFile(
      join(agentDir, 'shared.md'),
      '---\nname: shared\ndescription: Shared user resource\n---\nBody',
    );
    await writeFile(
      join(styleDir, 'shared.md'),
      '---\nname: shared\ndescription: Shared style\n---\nShared instructions',
    );
    expect(handles[0].user).toBe(handles[1].user);
    expect(handles[0].user.agents.getAllDiscoveredAgents()).toHaveLength(0);
    expect(handles[0].user.outputStyles.getAllDiscoveredOutputStyles()).toHaveLength(0);
    await Promise.all([
      handles[0].user.reloadAgents(),
      handles[0].user.reloadOutputStyles(),
    ]);
    for (const handle of handles) {
      expect(handle.user.agents.getAllDiscoveredAgents()[0].description).toBe(
        'Shared user resource',
      );
      expect(handle.user.outputStyles.getAllDiscoveredOutputStyles()[0].prompt).toBe(
        'Shared instructions',
      );
    }
    await Promise.all([
      rm(agentDir, { recursive: true }),
      rm(styleDir, { recursive: true }),
    ]);
    expect(handles[0].user.agents.getAllDiscoveredAgents()).toHaveLength(1);
    await Promise.all([
      handles[0].user.reloadAgents(),
      handles[0].user.reloadOutputStyles(),
    ]);
    expect(handles[1].user.agents.getAllDiscoveredAgents()).toHaveLength(0);
    expect(handles[1].user.outputStyles.getAllDiscoveredOutputStyles()).toHaveLength(0);
  } finally {
    await Promise.all(handles.map((handle) => handle.release()));
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('initializes and reloads valid skills beside links with ENOTDIR targets', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'resource-enotdir-')),
  );
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  const skills = join(cwd, '.qwen', 'skills');
  const target = join(root, 'external', 'skills');
  const valid = join(root, 'valid');
  const skill = (description: string) =>
    `---\nname: valid\ndescription: ${description}\n---\nbody`;
  await mkdir(home);
  await mkdir(skills, { recursive: true });
  await mkdir(join(root, 'external'));
  await mkdir(valid);
  // The customer's intermediate "skills" component was a file, not a directory.
  await writeFile(target, 'not a directory');
  for (let i = 0; i < 12; i++) {
    await symlink(join(target, `bad-${i}`), join(skills, `bad-${i}`));
  }
  await symlink(join(root, 'missing'), join(skills, 'missing'));
  await symlink('cycle', join(skills, 'cycle'));
  await writeFile(join(valid, 'SKILL.md'), skill('version one'));
  await symlink(valid, join(skills, 'valid'));
  const watcher = new FileSystemWatcher({
    usePolling: true,
    pollingIntervalMs: 40,
    debounceMs: 10,
    awaitWriteFinish: false,
  });
  const project = new ProjectResource({
    homeDir: home,
    cwd,
    isTrusted: true,
    fileWatcher: watcher,
  });
  try {
    await expect(
      Promise.race([
        project.ready.then(() => 'ready'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
      ]),
    ).resolves.toBe('ready');
    const find = () =>
      project.skills
        .getAllDiscoveredSkills()
        .find((entry) => entry.name === 'valid');
    expect(find()?.description).toBe('version one');
    await project.watcherReady;

    await writeFile(join(valid, 'SKILL.md'), skill('version two'));
    await vi.waitFor(() => expect(find()?.description).toBe('version two'), {
      timeout: 5000,
    });

    // Repair the malformed target and recreate its directory entry to notify the watcher.
    await unlink(target);
    await mkdir(join(target, 'bad-0'), { recursive: true });
    await writeFile(
      join(target, 'bad-0', 'SKILL.md'),
      '---\nname: recovered\ndescription: repaired\n---\nbody',
    );
    await unlink(join(skills, 'bad-0'));
    await symlink(join(target, 'bad-0'), join(skills, 'recovered'));
    const findRecovered = () =>
      project.skills
        .getAllDiscoveredSkills()
        .find((entry) => entry.name === 'recovered');
    await vi.waitFor(
      () => expect(findRecovered()?.description).toBe('repaired'),
      { timeout: 5000 },
    );
    await writeFile(
      join(target, 'bad-0', 'SKILL.md'),
      '---\nname: recovered\ndescription: updated\n---\nbody',
    );
    await vi.waitFor(
      () => expect(findRecovered()?.description).toBe('updated'),
      { timeout: 5000 },
    );
  } finally {
    await project.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
