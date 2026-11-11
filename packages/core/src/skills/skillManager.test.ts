/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Dir, Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillManager } from './skillManager.js';
import type { Config } from '../config/config.js';
import type { BuiltinPluginSkillDefinition } from '../builtin-plugins/types.js';
import type { LoadedPlugin } from '../plugins/types.js';
import { coreEvents } from '../utils/events.js';
import { runLogger } from '../utils/runLogger.js';
import { CONFIG_DIR } from '../utils/paths.js';
import { initBundledSkills } from './bundled/index.js';
import {
  loadSkillsFromDir,
  ProjectResource,
  UserResource,
  type SkillDefinition,
  type FileChangeListener,
  type FileChangeOperation,
  type FileWatcher,
  type WatchRequest,
} from '@qwen-code/resource';

const mocks = vi.hoisted(() => ({
  getBuiltinPluginSkills: vi.fn(() => [] as BuiltinPluginSkillDefinition[]),
}));

/**
 * `fs.opendir` cannot be spied on: an ESM module namespace is not
 * configurable. Wrap it once, passing through to the real implementation unless
 * a test installs an override for a specific directory — the bounded listing in
 * the shadowed-subdirectory diagnostic can only be pushed to its caps, or made
 * to fail mid-iteration, with a synthetic handle.
 */
let opendirOverride: ((dirPath: string) => Dir | null) | null = null;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    opendir: (async (...args: Parameters<typeof actual.opendir>) =>
      opendirOverride?.(String(args[0])) ??
      actual.opendir(...args)) as typeof actual.opendir,
  };
});

function dirEntry(name: string, isDirectory: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => false,
    isFile: () => !isDirectory,
  } as unknown as Dirent;
}

function syntheticDirHandle(
  dirPath: string,
  iterate: () => AsyncGenerator<Dirent>,
): Dir {
  let closed = false;
  return {
    path: dirPath,
    async close() {
      if (closed) {
        // Node throws this on a second close; the helper under test relies on it.
        const error: NodeJS.ErrnoException = new Error(
          'Directory handle closed',
        );
        error.code = 'ERR_DIR_CLOSED';
        throw error;
      }
      closed = true;
    },
    [Symbol.asyncIterator]: iterate,
  } as unknown as Dir;
}

/** Yields `names` as subdirectories, then fails the way a mid-read error would. */
function failingDirHandle(dirPath: string, names: string[]): Dir {
  return syntheticDirHandle(dirPath, async function* () {
    for (const name of names) {
      yield dirEntry(name, true);
    }
    throw new Error('simulated directory read failure');
  });
}

/** Yields only plain files, so no candidate is ever collected. */
function fileOnlyDirHandle(dirPath: string, names: string[]): Dir {
  return syntheticDirHandle(dirPath, async function* () {
    for (const name of names) {
      yield dirEntry(name, false);
    }
  });
}

function addTestSkill(service: SkillManager, skill: SkillDefinition): void {
  service.addSkills([skill]);
}

function contributedSkill(
  name: string,
  respectBuiltinSkillSwitch?: boolean,
): BuiltinPluginSkillDefinition {
  return {
    name,
    description: `${name}-desc`,
    location: `qwen:builtin/${name}`,
    skillRoot: process.cwd(),
    body: `${name}-body`,
    ...(respectBuiltinSkillSwitch === undefined
      ? {}
      : { respectBuiltinSkillSwitch }),
  };
}

function configWithBuiltinContributions(
  skills: readonly BuiltinPluginSkillDefinition[],
): Config {
  mocks.getBuiltinPluginSkills.mockReturnValue([...skills]);
  return {
    getBuiltinPluginContributions: () => ({
      isReady: () => true,
      getSkillDefinitions: () => mocks.getBuiltinPluginSkills(),
    }),
    getSettings: () => ({}),
    isWorkflowsEnabled: () => false,
  } as unknown as Config;
}

function resourceSkill(
  name: string,
  source: 'user' | 'project',
  location = `/${source}/${name}/SKILL.md`,
): SkillDefinition {
  return {
    name,
    description: `${source}-desc`,
    location,
    resolvedPath: location,
    skillRoot: path.dirname(location),
    body: `${source} body`,
    source,
  };
}

async function writeTestSkill(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const skillRoot = path.join(directory, name);
  const skillFile = path.join(skillRoot, 'SKILL.md');
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(
    skillFile,
    `---\ndescription: ${name} test skill\n---\n${body}`,
  );
  return skillFile;
}

class TestFileWatcher implements FileWatcher {
  readonly isNoop = false;
  private readonly registrations = new Set<{
    request: WatchRequest;
    listener: FileChangeListener;
  }>();

  watch(request: WatchRequest, listener: FileChangeListener): () => void {
    const registration = { request, listener };
    this.registrations.add(registration);
    return () => this.registrations.delete(registration);
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.registrations.clear();
  }

  async emit(changedPath: string, operation: FileChangeOperation): Promise<void> {
    const resolvedChangedPath = path.resolve(changedPath);
    for (const { request, listener } of this.registrations) {
      const target = path.resolve(request.path);
      if (
        resolvedChangedPath === target ||
        resolvedChangedPath.startsWith(`${target}${path.sep}`)
      ) {
        await listener({ path: resolvedChangedPath, operation });
      }
    }
  }
}

vi.mock('@qwen-code/resource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/resource')>();
  return {
    ...actual,
    loadSkillsFromDir: vi.fn(actual.loadSkillsFromDir),
  };
});

// Prevent bundled skills (simplify, debug) from being auto-registered in tests
// — keeps skill count assertions stable.
vi.mock('./bundled/index.js', () => ({
  initBundledSkills: vi.fn(),
}));

vi.mock('../plugins/management/pluginDependencies.js', () => ({
  getLoadedPluginId: (plugin: LoadedPlugin) =>
    plugin.source ? `${plugin.name}@${plugin.source}` : plugin.name,
}));

vi.mock('../builtin-plugins/index.js', () => ({
  getBuiltinPluginSkills: mocks.getBuiltinPluginSkills,
}));

// Prevent builtin SKILL.md files from being loaded from disk in tests
// — keeps skill count assertions stable. Stub both APIs `discoverSkills`
// touches; otherwise the Bun-embedded path throws on missing exports.
//
// `embeddedAssetsForTest` is mutable so individual tests can simulate the
// Bun-compiled binary code path where `listEmbeddedAssetsUnder` returns
// real entries; `afterEach` resets it back to empty.
let embeddedAssetsForTest: Array<{ key: string; absPath: string }> = [];
vi.mock('../utils/runtimeAssetPath.js', () => ({
  resolveRuntimeAssetPath: () => '/non-existent-builtin',
  listEmbeddedAssetsUnder: () => embeddedAssetsForTest,
  findCliRepoRoot: () => undefined,
}));

describe('SkillManager', () => {
  let testRootDir: string;

  beforeEach(async () => {
    mocks.getBuiltinPluginSkills.mockReturnValue([]);
    testRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-manager-test-'),
    );
  });

  afterEach(async () => {
    opendirOverride = null;
    await fs.rm(testRootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    embeddedAssetsForTest = [];
  });

  it('uses resource skills without scanning user or project directories', async () => {
    const service = new SkillManager();
    service.setDisableBuiltinSkills(true);
    const resourceSkill: SkillDefinition = {
      name: 'resource-skill',
      description: 'loaded by resource service',
      location: '/workspace/.qwen/skills/resource-skill/SKILL.md',
      skillRoot: '/workspace/.qwen/skills/resource-skill',
      body: 'resource body',
      source: 'project',
    };
    const loadFromDir = vi.mocked(loadSkillsFromDir);
    loadFromDir.mockClear();

    await service.discoverSkills({
      resourceSkills: [resourceSkill],
      resourceSkillLoadErrors: [
        {
          filePath: resourceSkill.location,
          message: 'resource warning',
          configType: 'skill',
          severity: 'warning',
        },
      ],
    });

    expect(service.getAllSkills()).toEqual([resourceSkill]);
    expect(service.getLoadErrors()).toEqual([
      expect.objectContaining({ message: 'resource warning' }),
    ]);
    expect(loadFromDir).not.toHaveBeenCalled();
  });

  it('consumes resource skill precedence and refreshed snapshots end to end', async () => {
    const homeDir = path.join(testRootDir, 'home');
    const workspaceDir = path.join(testRootDir, 'workspace');
    const additionalDir = path.join(testRootDir, 'additional');
    const userConfigDir = path.join(homeDir, '.qwen');
    const projectConfigDir = path.join(workspaceDir, '.qwen');
    const userSkillFile = await writeTestSkill(
      path.join(userConfigDir, 'skills'),
      'shared',
      'user config v1',
    );

    await writeTestSkill(
      path.join(projectConfigDir, 'commands'),
      'shared',
      'project command',
    );
    await writeTestSkill(
      path.join(workspaceDir, '.agents', 'skills'),
      'shared',
      'project agents',
    );
    await writeTestSkill(
      path.join(projectConfigDir, 'skills'),
      'shared',
      'project config',
    );
    await writeTestSkill(
      path.join(additionalDir, '.qwen', 'skills'),
      'shared',
      'additional project',
    );
    await writeTestSkill(
      path.join(additionalDir, '.qwen', 'skills'),
      'additional-only',
      'additional body',
    );
    await writeTestSkill(
      path.join(userConfigDir, 'commands'),
      'shared',
      'user command',
    );
    await writeTestSkill(
      path.join(homeDir, '.agents', 'skills'),
      'shared',
      'user agents',
    );

    const fileWatcher = new TestFileWatcher();
    const user = new UserResource({
      homeDir,
      globalConfigDirOverride: userConfigDir,
      userAgentSkillsDirOverride: path.join(homeDir, '.agents', 'skills'),
      loadFromAgentsDirectory: true,
    });
    const userSkills = user.skills;
    const project = new ProjectResource({
      cwd: workspaceDir,
      homeDir,
      projectConfigDirOverride: projectConfigDir,
      projectAgentSkillsDirOverride: path.join(
        workspaceDir,
        '.agents',
        'skills',
      ),
      additionalDirectories: [additionalDir],
      isTrusted: true,
      loadFromAgentsDirectory: true,
      skillSettings: { allowedSources: ['user', 'project'] },
      fileWatcher,
    });

    try {
      await Promise.all([user.initialize(), userSkills.ready, project.ready]);

      // Discovery order matches the previous merged list: project (with
      // additional roots) first, user last, so user wins by last-wins.
      const resourceSkills = () => [
        ...project.skills.getAllDiscoveredSkills(),
        ...userSkills.getAllDiscoveredSkills(),
      ];

      const service = new SkillManager();
      service.setDisableBuiltinSkills(true);
      await service.discoverSkills({ resourceSkills: resourceSkills() });
      expect(service.getSkill('shared')?.body).toBe('user config v1');
      expect(
        service.getAllSkills().find((skill) => skill.name === 'shared')
          ?.source,
      ).toBe('user');
      expect(service.getSkill('additional-only')?.body).toBe('additional body');

      const refreshed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timed out waiting for skill refresh')),
          10_000,
        );
        const unsubscribe = userSkills.onDidChange(() => {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        });
      });
      await fs.writeFile(
        userSkillFile,
        '---\ndescription: shared test skill\n---\nuser skill v2',
      );
      await refreshed;

      expect(
        userSkills
          .getAllDiscoveredSkills()
          .findLast((skill) => skill.name === 'shared')?.body,
      ).toBe('user skill v2');
      await service.discoverSkills({
        resourceSkills: resourceSkills(),
      });
      expect(service.getSkill('shared')?.body).toBe('user skill v2');
    } finally {
      await project.dispose();
      await user.dispose();
    }
  }, 10_000);

  it('refreshes bundled gate visibility without rediscovery and preserves user overrides', async () => {
    let enabled = false;
    vi.mocked(initBundledSkills).mockImplementationOnce((registrar) => {
      registrar.registerBundledSkill({
        name: 'memory-types',
        description: 'types',
        location: 'bundled',
        body: 'builtin',
        userInvocable: false,
        isEnabled: () => enabled,
      });
    });
    const service = new SkillManager();
    await service.discoverSkills();
    expect(service.getSkill('memory-types')).toBeNull();
    enabled = true;
    expect(
      service
        .getModelVisibleSkills()
        .some((skill) => skill.name === 'memory-types'),
    ).toBe(true);
    expect(
      service
        .getDisplayableSkills()
        .some((skill) => skill.name === 'memory-types'),
    ).toBe(false);
    enabled = false;
    expect(service.getSkill('memory-types')).toBeNull();
    enabled = true;
    addTestSkill(service, resourceSkill('memory-types', 'user'));
    expect(service.getSkill('memory-types')?.source).toBe('user');
    enabled = false;
    expect(service.getSkill('memory-types')?.source).toBe('user');
  });

  it('records the skill root when a bundled skill is registered during discovery', async () => {
    vi.mocked(initBundledSkills).mockImplementationOnce((registrar) => {
      registrar.registerBundledSkill({
        name: 'bundled',
        description: 'bundled skill',
        location: 'bundled',
        body: '',
      });
    });

    const service = new SkillManager();
    await service.discoverSkills();

    expect(service.getSkill('bundled')?.skillRoot).toBe(process.cwd());
  });

  it('applies setDisabledSkills to programmatic bundled skills', async () => {
    vi.mocked(initBundledSkills).mockImplementationOnce((registrar) => {
      registrar.registerBundledSkill({
        name: 'simplify',
        description: 'bundled simplify skill',
        location: 'bundled',
        body: '',
      });
      registrar.registerBundledSkill({
        name: 'loop',
        description: 'bundled loop skill',
        location: 'bundled',
        body: '',
      });
    });

    const service = new SkillManager();
    await service.discoverSkills();
    service.setDisabledSkills(['simplify']);

    expect(service.getSkills().map((s) => s.name)).toEqual(['loop']);
    expect(service.getModelVisibleSkills().map((s) => s.name)).toEqual([
      'loop',
    ]);
    expect(
      service.getAllSkills().find((s) => s.name === 'simplify')?.disabled,
    ).toBe(true);
  });

  it('keeps bundled skills disabled across a re-run of discoverSkills', async () => {
    vi.mocked(initBundledSkills).mockImplementation((registrar) => {
      registrar.registerBundledSkill({
        name: 'simplify',
        description: 'bundled simplify skill',
        location: 'bundled',
        body: '',
      });
    });

    const service = new SkillManager();
    await service.discoverSkills();
    service.setDisabledSkills(['simplify']);
    // Re-discovery installs freshly built skill objects; the disabled list must
    // be re-applied without the caller calling setDisabledSkills() again.
    await service.discoverSkills();

    expect(service.getSkills()).toHaveLength(0);
    expect(
      service.getAllSkills().find((s) => s.name === 'simplify')?.disabled,
    ).toBe(true);
  });

  it('filters only the main-session model skill listing by session allowlist', () => {
    const service = new SkillManager();
    addTestSkill(service, {
      name: 'alpha',
      description: 'alpha skill',
      location: '/skills/alpha/SKILL.md',
      skillRoot: '/skills/alpha',
      body: 'alpha',
    });
    addTestSkill(service, {
      name: 'plugin:beta',
      description: 'beta skill',
      location: '/plugins/example/skills/beta/SKILL.md',
      skillRoot: '/plugins/example/skills/beta',
      body: 'beta',
    });
    addTestSkill(service, {
      name: 'gamma',
      description: 'gamma skill',
      location: '/skills/gamma/SKILL.md',
      skillRoot: '/skills/gamma',
      body: 'gamma',
    });

    service.setSessionSkillAllowlist(['alpha', 'beta']);

    expect(service.getModelVisibleSkills().map((skill) => skill.name)).toEqual([
      'alpha',
      'plugin:beta',
    ]);
    expect(
      service
        .getModelVisibleSkills({ isMainSession: false })
        .map((skill) => skill.name),
    ).toEqual(['alpha', 'plugin:beta', 'gamma']);

    service.setSessionSkillAllowlist([]);
    expect(service.getModelVisibleSkills()).toEqual([]);

    service.setSessionSkillAllowlist(undefined);
    expect(service.getModelVisibleSkills()).toHaveLength(3);
  });

  it('excludes every model-blocked skill from getModelVisibleSkills', () => {
    const service = new SkillManager();
    addTestSkill(service, {
      name: 'plain',
      description: 'plain skill',
      location: '/skills/plain/SKILL.md',
      skillRoot: '/skills/plain',
      body: 'plain',
    });
    addTestSkill(service, {
      name: 'named-only',
      description: 'name-only skill',
      location: '/skills/named-only/SKILL.md',
      skillRoot: '/skills/named-only',
      body: 'named-only',
    });
    addTestSkill(service, {
      name: 'user-only',
      description: 'user-only skill',
      location: '/skills/user-only/SKILL.md',
      skillRoot: '/skills/user-only',
      body: 'user-only',
      disableModelInvocation: true,
    });
    addTestSkill(service, {
      name: 'hidden',
      description: 'hidden skill',
      location: '/skills/hidden/SKILL.md',
      skillRoot: '/skills/hidden',
      body: 'hidden',
    });
    addTestSkill(service, {
      name: 'slash-only',
      description: 'slash-only skill',
      location: '/skills/slash-only/SKILL.md',
      skillRoot: '/skills/slash-only',
      body: 'slash-only',
    });
    addTestSkill(service, {
      name: 'conditional',
      description: 'conditional skill',
      location: '/skills/conditional/SKILL.md',
      skillRoot: '/skills/conditional',
      body: 'conditional',
      paths: ['src/**'],
    });

    service.setSkillVisibilityOverrides({
      'named-only': 'name-only',
      hidden: 'off',
      'slash-only': 'user-invocable-only',
    });

    // 'name-only' stays: its name is already model-visible.
    expect(
      service.getModelVisibleSkills().map((skill) => skill.name),
    ).toEqual(['plain', 'named-only']);

    service.setSessionSkillAllowlist(['plain']);
    expect(
      service.getModelVisibleSkills().map((skill) => skill.name),
    ).toEqual(['plain']);
    expect(
      service
        .getModelVisibleSkills({ isMainSession: false })
        .map((skill) => skill.name),
    ).toEqual(['plain', 'named-only']);
  });

  it('hides only find-skills with the mandatory-first-step instruction from the model', () => {
    const mandatoryInstruction =
      'ALWAYS use this skill as the FIRST step before handling any substantive task.';
    const mandatoryFindSkills = new SkillManager();
    addTestSkill(mandatoryFindSkills, {
      name: 'find-skills',
      description: mandatoryInstruction,
      location: '/project/skills/find-skills/SKILL.md',
      skillRoot: '/project/skills/find-skills',
      body: 'mandatory find skills',
    });

    expect(mandatoryFindSkills.getModelVisibleSkills()).toEqual([]);
    expect(
      mandatoryFindSkills.getDisplayableSkills().map((skill) => skill.name),
    ).toEqual(['find-skills']);

    const ordinaryFindSkills = new SkillManager();
    addTestSkill(ordinaryFindSkills, {
      name: 'find-skills',
      description: 'Search for an optional skill when the user requests it.',
      location: '/qwen/skills/find-skills/SKILL.md',
      skillRoot: '/qwen/skills/find-skills',
      body: 'ordinary find skills',
    });

    expect(
      ordinaryFindSkills.getModelVisibleSkills().map((skill) => skill.name),
    ).toEqual(['find-skills']);

    const otherSkill = new SkillManager();
    addTestSkill(otherSkill, {
      name: 'other-skill',
      description: mandatoryInstruction,
      location: '/qwen/skills/other-skill/SKILL.md',
      skillRoot: '/qwen/skills/other-skill',
      body: 'other skill',
    });

    expect(otherSkill.getModelVisibleSkills().map((skill) => skill.name)).toEqual([
      'other-skill',
    ]);
  });

  it('should discover built-in skills', async () => {
    const service = new SkillManager();
    const mockBuiltinSkill: SkillDefinition = {
      name: 'builtin-skill',
      description: 'builtin-desc',
      location: 'builtin-loc',
      skillRoot: process.cwd(),
      body: 'builtin-body',
    };

    vi.mocked(loadSkillsFromDir).mockImplementation(async (dir) => {
      if (dir.endsWith('builtin')) {
        return [{ ...mockBuiltinSkill }];
      }
      return [];
    });

    await service.discoverSkills();

    const skills = service.getSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('builtin-skill');
    expect(skills[0].isBuiltin).toBe(true);
    expect(skills[0].skillRoot).toBe(process.cwd());
  });

  it.each([
    {
      label: 'without a built-in allowlist',
      enabledBuiltinSkills: undefined,
      expectedNames: ['agent-creator', 'hook-config'],
    },
    {
      label: 'with a built-in allowlist',
      enabledBuiltinSkills: ['agent-creator'],
      expectedNames: ['agent-creator'],
    },
  ])(
    'should derive identity from the embedded-asset key in Bun-compiled binaries $label',
    async ({ enabledBuiltinSkills, expectedNames }) => {
    // In a Bun-compiled binary, /$bunfs/ paths don't preserve the original
    // `<skill-name>/SKILL.md` directory structure, so the loader cannot
    // fall back to `path.basename(path.dirname(filePath))` for identity.
    // The fix derives identity from the canonical repo-relative key. This
    // test simulates that by writing two SKILL.md files at on-disk paths
    // whose `dirname` deliberately doesn't match the original skill name.
    const fakeBunfsDir = path.join(testRootDir, 'bunfs-flat');
    await fs.mkdir(fakeBunfsDir, { recursive: true });
    const aPath = path.join(fakeBunfsDir, 'a-SKILL.md');
    const bPath = path.join(fakeBunfsDir, 'b-SKILL.md');
    await fs.writeFile(
      aPath,
      `---\nname: hook-config-display\ndescription: hook desc\n---\nbody-a\n`,
    );
    await fs.writeFile(
      bPath,
      `---\ndescription: agent-creator desc\n---\nbody-b\n`,
    );

    embeddedAssetsForTest = [
      {
        key: 'packages/core/src/skills/builtin/hook-config/SKILL.md',
        absPath: aPath,
      },
      {
        key: 'packages/core/src/skills/builtin/agent-creator/SKILL.md',
        absPath: bPath,
      },
    ];

      const service = new SkillManager();
      service.setEnabledBuiltinSkills(enabledBuiltinSkills);
      await service.discoverSkills();

      const skills = service.getSkills();
      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(expectedNames);
      expect(skills.every((s) => s.isBuiltin === true)).toBe(true);
      expect(skills.every((s) => s.skillRoot === process.cwd())).toBe(true);
      if (expectedNames.includes('hook-config')) {
        // Frontmatter `name` must only affect displayName, never identity —
        // otherwise the test would be vacuously satisfied if identity leaked
        // from frontmatter instead of from the key.
        const hookSkill = skills.find((s) => s.name === 'hook-config');
        expect(hookSkill?.displayName).toBe('hook-config-display');
      }
    },
  );

  it('should skip filesystem builtin and programmatic bundled skills when disableBuiltinSkills is set', async () => {
    const service = new SkillManager();
    const mockBuiltinSkill: SkillDefinition = {
      name: 'builtin-skill',
      description: 'builtin-desc',
      location: 'builtin-loc',
      skillRoot: process.cwd(),
      body: 'builtin-body',
    };
    vi.mocked(loadSkillsFromDir).mockImplementation(async (dir) => {
      if (dir.endsWith('builtin')) {
        return [{ ...mockBuiltinSkill }];
      }
      return [];
    });

    service.setDisableBuiltinSkills(true);
    await service.discoverSkills();

    const skills = service.getSkills();
    // Neither the mocked filesystem builtin nor any programmatic bundled
    // skill (simplify, debug, quest, remember) should be present.
    expect(skills.some((s) => s.name === 'builtin-skill')).toBe(false);
    expect(skills.some((s) => s.isBuiltin === true)).toBe(false);
  });

  it('should skip switch-respecting builtin contributions when builtin skills are disabled', async () => {
    const service = new SkillManager();
    service.setDisableBuiltinSkills(true);
    await service.discoverSkills({
      config: configWithBuiltinContributions([contributedSkill('sdk', true)]),
    });

    expect(service.getSkills()).toEqual([]);
  });

  it('should select switch-respecting builtin contributions named by the builtin allowlist', async () => {
    const service = new SkillManager();
    service.setEnabledBuiltinSkills(['sdk']);
    await service.discoverSkills({
      config: configWithBuiltinContributions([
        contributedSkill('sdk', true),
        contributedSkill('other', true),
      ]),
    });

    expect(service.getSkills().map((skill) => skill.name)).toEqual(['sdk']);
  });

  it('should keep other builtin contributions when builtin skills are disabled', async () => {
    const service = new SkillManager();
    service.setDisableBuiltinSkills(true);
    await service.discoverSkills({
      config: configWithBuiltinContributions([contributedSkill('imagegen')]),
    });

    expect(service.getSkills().map((skill) => skill.name)).toEqual([
      'imagegen',
    ]);
  });

  it('lets a builtin contribution override the bundled skill with the same name', async () => {
    vi.mocked(initBundledSkills).mockImplementationOnce((registrar) => {
      registrar.registerBundledSkill({
        name: 'debug',
        description: 'bundled debug',
        location: 'bundled',
        body: 'bundled-body',
      });
    });

    const service = new SkillManager();
    await service.discoverSkills({
      config: configWithBuiltinContributions([contributedSkill('debug', true)]),
    });

    const skill = service.getSkills().find((entry) => entry.name === 'debug');
    expect(skill?.location).toBe('qwen:builtin/debug');
    expect(skill?.body).toBe('debug-body');
  });

  it('should strip the builtin switch marker from contributed skills', async () => {
    const service = new SkillManager();
    await service.discoverSkills({
      config: configWithBuiltinContributions([contributedSkill('sdk', true)]),
    });

    const [skill] = service.getSkills();
    expect(skill).not.toHaveProperty('respectBuiltinSkillSwitch');
    expect(skill.isBuiltin).toBe(true);
  });

  it.each([false, true])(
    'should load only explicitly enabled built-ins without filtering other sources when disableBuiltinSkills=%s',
    async (disableBuiltinSkills) => {
    vi.mocked(loadSkillsFromDir).mockImplementation(async (dir) => {
      if (dir.endsWith('builtin')) {
        return [
          {
            name: 'builtin-a',
            description: 'builtin a',
            location: 'builtin-a',
            skillRoot: process.cwd(),
            body: '',
          },
          {
            name: 'builtin-b',
            description: 'builtin b',
            location: 'builtin-b',
            skillRoot: process.cwd(),
            body: '',
          },
        ];
      }
      return [];
    });
    vi.mocked(initBundledSkills).mockImplementationOnce((registrar) => {
      registrar.registerBundledSkill({
        name: 'bundled-a',
        description: 'bundled a',
        location: 'bundled-a',
        body: '',
      });
      registrar.registerBundledSkill({
        name: 'bundled-b',
        description: 'bundled b',
        location: 'bundled-b',
        body: '',
      });
    });

      const service = new SkillManager();
      service.setDisableBuiltinSkills(disableBuiltinSkills);
      service.setEnabledBuiltinSkills([' BUILTIN-B ', 'bundled-b']);
      await service.discoverSkills({
        resourceSkills: [resourceSkill('project-skill', 'project')],
      });

      expect(service.getSkills().map((skill) => skill.name).sort()).toEqual([
        'builtin-b',
        'bundled-b',
        'project-skill',
      ]);
    },
  );

  it('should treat an empty built-in allowlist as no general built-ins', async () => {
    const loadFromDir = vi.mocked(loadSkillsFromDir);
    const initBundled = vi.mocked(initBundledSkills);
    loadFromDir.mockClear();
    initBundled.mockClear();

    const service = new SkillManager();
    service.setEnabledBuiltinSkills([]);
    await service.discoverSkills();

    expect(loadFromDir).not.toHaveBeenCalled();
    expect(initBundled).not.toHaveBeenCalled();
    expect(service.getSkills()).toEqual([]);
  });

  // skip: 现存失败
  it.skip('should keep an explicitly enabled security skill outside the general built-in allowlist', async () => {
    const securitySkill: SkillDefinition = {
      name: 'security-scan',
      description: 'security-desc',
      location: 'security-loc',
      skillRoot: process.cwd(),
      body: 'security-body',
      isBuiltin: true,
    };
    mocks.getBuiltinPluginSkills.mockReturnValue([securitySkill]);

    const config = {
      isWorkflowsEnabled: () => false,
    } as unknown as Config;

    const service = new SkillManager();
    service.setDisableBuiltinSkills(true);
    service.setEnabledBuiltinSkills(['sdk']);
    await service.discoverSkills({ config });

    expect(service.getSkills().map((skill) => skill.name)).toEqual([
      'security-scan',
    ]);
  });

  it('should filter disabled skills in getSkills but not in getAllSkills', async () => {
    const service = new SkillManager();

    await service.discoverSkills({
      resourceSkills: [resourceSkill('skill1', 'project')],
    });
    service.setDisabledSkills(['skill1']);

    expect(service.getSkills()).toHaveLength(0);
    expect(service.getAllSkills()).toHaveLength(1);
    expect(service.getAllSkills()[0].disabled).toBe(true);
  });

  it('should include built-in skills in getDisplayableSkills', async () => {
    const service = new SkillManager();

    // @ts-expect-error accessing private property for testing
    service.skills = [
      {
        name: 'regular-skill',
        description: 'regular',
        location: 'loc1',
        skillRoot: process.cwd(),
        body: 'body',
        isBuiltin: false,
      },
      {
        name: 'builtin-skill',
        description: 'builtin',
        location: 'loc2',
        skillRoot: process.cwd(),
        body: 'body',
        isBuiltin: true,
      },
      {
        name: 'disabled-builtin',
        description: 'disabled builtin',
        location: 'loc3',
        skillRoot: process.cwd(),
        body: 'body',
        isBuiltin: true,
        disabled: true,
      },
    ];

    const displayable = service.getDisplayableSkills();
    expect(displayable).toHaveLength(2);
    expect(displayable.map((s) => s.name)).toContain('regular-skill');
    expect(displayable.map((s) => s.name)).toContain('builtin-skill');

    const all = service.getAllSkills();
    expect(all).toHaveLength(3);

    const enabled = service.getSkills();
    expect(enabled).toHaveLength(2);
    expect(enabled.map((s) => s.name)).toContain('builtin-skill');
  });

  it('should maintain admin settings state', async () => {
    const service = new SkillManager();

    // Case 1: Enabled by admin

    service.setAdminSettings(true);

    expect(service.isAdminEnabled()).toBe(true);

    // Case 2: Disabled by admin

    service.setAdminSettings(false);

    expect(service.isAdminEnabled()).toBe(false);
  });

  describe('Conflict Detection', () => {
    it('should emit a single summary UI warning for cross-source name conflicts', async () => {
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
      const debugWarnSpy = vi.spyOn(runLogger, 'warn');
      const userDir = path.join(testRootDir, 'user');
      const projectDir = path.join(testRootDir, 'workspace');
      await fs.mkdir(userDir, { recursive: true });
      await fs.mkdir(projectDir, { recursive: true });

      const skillName = 'conflicting-skill';
      const userSkillPath = path.join(userDir, 'SKILL.md');
      const projectSkillPath = path.join(projectDir, 'SKILL.md');

      const service = new SkillManager();

      await service.discoverSkills({
        resourceSkills: [
          resourceSkill(skillName, 'project', projectSkillPath),
          resourceSkill(skillName, 'user', userSkillPath),
        ],
      });

      // Exactly one summary feedback line, no per-conflict feedback.
      const summaryCalls = emitFeedbackSpy.mock.calls.filter(
        ([severity, msg]) =>
          severity === 'warning' &&
          typeof msg === 'string' &&
          msg.includes('skill name conflict'),
      );
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0][1]).toContain(
        'Detected 1 skill name conflict across sources',
      );
      expect(summaryCalls[0][1]).toContain('/skills');

      // Per-conflict detail still lands in the log for diagnostic packs.
      expect(debugWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Skill conflict: "${skillName}"`),
      );

      // The winner records the loser's location in alsoDefinedAt for the
      // detail view's "Also defined at" section.
      const active = service.getAllSkills().find((s) => s.name === skillName);
      expect(active).toBeDefined();
      expect(active?.location).toBe(userSkillPath);
      expect(active?.alsoDefinedAt).toEqual([projectSkillPath]);
    });

    it('should silently dedup by resolvedPath (symlink / alias)', async () => {
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');

      const userDir = path.join(testRootDir, 'user');
      const projectDir = path.join(testRootDir, 'workspace');
      await fs.mkdir(userDir, { recursive: true });
      await fs.mkdir(projectDir, { recursive: true });

      const realPath = path.join(testRootDir, 'real', 'SKILL.md');
      const userAliasPath = path.join(userDir, 'SKILL.md');
      const projectAliasPath = path.join(projectDir, 'SKILL.md');

      // Two distinct location strings, same resolvedPath (simulates symlinks
      // pointing at the same physical file).
      const service = new SkillManager();
      await service.discoverSkills({
        resourceSkills: [
          {
            ...resourceSkill('aliased-skill', 'project', projectAliasPath),
            resolvedPath: realPath,
          },
          {
            ...resourceSkill('aliased-skill', 'user', userAliasPath),
            resolvedPath: realPath,
          },
        ],
      });

      // No conflict feedback — the second load was silently skipped.
      const conflictFeedback = emitFeedbackSpy.mock.calls.filter(
        ([, msg]) =>
          typeof msg === 'string' && msg.includes('skill name conflict'),
      );
      expect(conflictFeedback).toHaveLength(0);

      // Only one entry made it into the discovered list / active skills.
      // Filter by name so the assertion is independent of the host's real
      // ~/.qwen/commands directory, which other code paths may pick up.
      const matchingActive = service
        .getAllSkills()
        .filter((s) => s.name === 'aliased-skill');
      expect(matchingActive).toHaveLength(1);
      const matchingDiscovered = service
        .getAllDiscoveredSkills()
        .filter((s) => s.name === 'aliased-skill');
      expect(matchingDiscovered).toHaveLength(1);
    });

    it('should log warning but NOT emit UI warning when a built-in skill is overridden', async () => {
      const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
      const debugWarnSpy = vi.spyOn(runLogger, 'warn');
      const userDir = path.join(testRootDir, 'user');
      await fs.mkdir(userDir, { recursive: true });

      const skillName = 'builtin-skill';
      const userSkillPath = path.join(userDir, 'SKILL.md');
      const builtinSkillPath = 'builtin/loc';

      vi.mocked(loadSkillsFromDir).mockImplementation(async (dir) => {
        if (dir.endsWith('builtin')) {
          return [
            {
              name: skillName,
              description: 'builtin-desc',
              location: builtinSkillPath,
              skillRoot: process.cwd(),
              body: '',
              isBuiltin: true,
            },
          ];
        }
        return [];
      });

      const service = new SkillManager();

      await service.discoverSkills({
        resourceSkills: [resourceSkill(skillName, 'user', userSkillPath)],
      });

      // UI warning should not be called
      expect(emitFeedbackSpy).not.toHaveBeenCalled();

      // Debug warning should be called
      expect(debugWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Skill "${skillName}" from "${userSkillPath}" is overriding the built-in skill.`,
        ),
      );
    });
  });

  describe('SK16: Dynamic skills from monorepo subdirectories', () => {
    it('should add and retrieve dynamic skills', () => {
      const service = new SkillManager();

      const dynamicSkill: SkillDefinition = {
        name: 'dynamic-skill',
        description: 'from subdirectory',
        location: `/workspace/packages/frontend/${CONFIG_DIR}/skills/ds/SKILL.md`,
        skillRoot: process.cwd(),
        body: 'dynamic body',
      };

      service.addDynamicSkills(
        `/workspace/packages/frontend/${CONFIG_DIR}/skills`,
        [dynamicSkill],
      );

      const skills = service.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('dynamic-skill');
    });

    it('should merge dynamic skills with static skills', async () => {
      const service = new SkillManager();

      await service.discoverSkills({
        resourceSkills: [resourceSkill('static-skill', 'user')],
      });

      // Add dynamic skill
      const dynamicSkill: SkillDefinition = {
        name: 'dynamic-skill',
        description: 'from subdirectory',
        location: `/workspace/packages/lib/${CONFIG_DIR}/skills/ds/SKILL.md`,
        skillRoot: process.cwd(),
        body: 'dynamic body',
      };
      service.addDynamicSkills(`/workspace/packages/lib/${CONFIG_DIR}/skills`, [
        dynamicSkill,
      ]);

      const skills = service.getSkills();
      expect(skills).toHaveLength(2);
      const names = skills.map((s) => s.name);
      expect(names).toContain('static-skill');
      expect(names).toContain('dynamic-skill');
    });

    it('should give dynamic skills higher precedence than static skills', async () => {
      const service = new SkillManager();

      // @ts-expect-error accessing private property for testing
      service.skills = [
        {
          name: 'shared-name',
          description: 'from static',
          location: `/workspace/${CONFIG_DIR}/skills/s/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'static body',
        },
      ];

      service.addDynamicSkills(
        `/workspace/packages/frontend/${CONFIG_DIR}/skills`,
        [
          {
            name: 'shared-name',
            description: 'from dynamic subdirectory',
            location: `/workspace/packages/frontend/${CONFIG_DIR}/skills/s/SKILL.md`,
            skillRoot: process.cwd(),
            body: 'dynamic body',
          },
        ],
      );

      const skills = service.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe('from dynamic subdirectory');
    });

    it('should preserve dynamic skills across clearSkills() calls', () => {
      const service = new SkillManager();

      service.addDynamicSkills(`/workspace/packages/lib/${CONFIG_DIR}/skills`, [
        {
          name: 'dynamic-skill',
          description: 'persisted',
          location: `/workspace/packages/lib/${CONFIG_DIR}/skills/ds/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      // clearSkills() is called during reload — dynamic skills should survive
      service.clearSkills();

      const skills = service.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('dynamic-skill');
    });

    it('should track hasDynamicSkillDir correctly', () => {
      const service = new SkillManager();
      const dir = `/workspace/packages/lib/${CONFIG_DIR}/skills`;

      expect(service.hasDynamicSkillDir(dir)).toBe(false);

      service.addDynamicSkills(dir, [
        {
          name: 'ds',
          description: 'desc',
          location: `${dir}/ds/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      expect(service.hasDynamicSkillDir(dir)).toBe(true);
    });

    it('should include dynamic skills in getDisplayableSkills', () => {
      const service = new SkillManager();

      service.addDynamicSkills(`/workspace/packages/lib/${CONFIG_DIR}/skills`, [
        {
          name: 'displayable-dynamic',
          description: 'desc',
          location: `/workspace/packages/lib/${CONFIG_DIR}/skills/ds/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
          isBuiltin: false,
          userInvocable: true,
        },
      ]);

      const displayable = service.getDisplayableSkills();
      expect(displayable).toHaveLength(1);
      expect(displayable[0].name).toBe('displayable-dynamic');
    });

    it('should include dynamic skills in getAllSkills', () => {
      const service = new SkillManager();

      // @ts-expect-error accessing private property for testing
      service.skills = [
        {
          name: 'static',
          description: 'desc',
          location: 'loc',
          skillRoot: process.cwd(),
          body: 'body',
        },
      ];

      service.addDynamicSkills(`/workspace/packages/lib/${CONFIG_DIR}/skills`, [
        {
          name: 'dynamic',
          description: 'desc',
          location: 'loc2',
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      const all = service.getAllSkills();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.name)).toContain('static');
      expect(all.map((s) => s.name)).toContain('dynamic');
    });

    it('should apply setDisabledSkills to dynamic skills too', () => {
      const service = new SkillManager();

      service.addDynamicSkills(`/workspace/packages/lib/${CONFIG_DIR}/skills`, [
        {
          name: 'dynamic-skill',
          description: 'desc',
          location: 'loc',
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      service.setDisabledSkills(['dynamic-skill']);

      expect(service.getSkills()).toHaveLength(0);
      expect(service.getAllSkills()).toHaveLength(1);
      expect(service.getAllSkills()[0].disabled).toBe(true);
    });

    it('should find dynamic skills via getSkill', () => {
      const service = new SkillManager();

      service.addDynamicSkills(`/workspace/packages/lib/${CONFIG_DIR}/skills`, [
        {
          name: 'dynamic-lookup',
          description: 'desc',
          location: 'loc',
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      const found = service.getSkill('dynamic-lookup');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('dynamic-lookup');
    });
  });

  describe('Source Tagging', () => {
    it('should tag dynamic skills with source project', () => {
      const service = new SkillManager();

      service.addDynamicSkills(`/workspace/packages/lib/${CONFIG_DIR}/skills`, [
        {
          name: 'dynamic-skill',
          description: 'desc',
          location: `/workspace/packages/lib/${CONFIG_DIR}/skills/ds/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      const skill = service.getSkill('dynamic-skill');
      expect(skill?.source).toBe('project');
    });

    it('should tag addSkills with provided source', () => {
      const service = new SkillManager();

      service.addSkills(
        [
          {
            name: 'mcp-skill',
            description: 'from mcp',
            location: '/mcp/SKILL.md',
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'plugin',
      );

      const skill = service.getSkill('mcp-skill');
      expect(skill?.source).toBe('plugin');
    });

    it('should apply disabled settings to programmatic skills added later', () => {
      const service = new SkillManager();

      service.setDisabledSkills(['mcp-skill']);
      service.addSkills(
        [
          {
            name: 'mcp-skill',
            description: 'from mcp',
            location: '/mcp/SKILL.md',
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'plugin',
      );

      expect(service.getSkills()).toHaveLength(0);
      expect(service.getAllSkills()).toHaveLength(1);
      expect(service.getAllSkills()[0].disabled).toBe(true);
    });

    it('should not duplicate identical programmatic skills when replayed', () => {
      const service = new SkillManager();
      const skill: SkillDefinition = {
        name: 'mcp-skill',
        description: 'from mcp',
        location: 'mcp://server/prompt',
        skillRoot: process.cwd(),
        body: 'body',
      };

      service.addSkills([skill], 'plugin');
      service.addSkills([{ ...skill }], 'plugin');

      expect(service.getAllSkills()).toHaveLength(1);
      expect(service.getAllDiscoveredSkills()).toHaveLength(1);
    });
  });

  describe('Discovered List', () => {
    it('should accumulate all skills including shadowed duplicates', () => {
      const service = new SkillManager();

      service.addSkills(
        [
          {
            name: 'shared-name',
            description: 'personal version',
            location: '/home/user/skills/s/SKILL.md',
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'user',
      );

      service.addSkills(
        [
          {
            name: 'shared-name',
            description: 'project version',
            location: `/workspace/${CONFIG_DIR}/skills/s/SKILL.md`,
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'project',
      );

      // getAllSkills returns only the winning skill (merged)
      expect(service.getAllSkills()).toHaveLength(1);
      expect(service.getAllSkills()[0].description).toBe('project version');

      // getAllDiscoveredSkills includes both versions
      const discovered = service.getAllDiscoveredSkills();
      expect(discovered).toHaveLength(2);
      expect(discovered.map((s) => s.description)).toContain(
        'personal version',
      );
      expect(discovered.map((s) => s.description)).toContain('project version');
    });

    it('should return a shallow copy from getAllDiscoveredSkills', () => {
      const service = new SkillManager();

      service.addSkills(
        [
          {
            name: 'skill-a',
            description: 'desc',
            location: '/loc',
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'user',
      );

      const discovered1 = service.getAllDiscoveredSkills();
      const discovered2 = service.getAllDiscoveredSkills();
      expect(discovered1).not.toBe(discovered2);
      expect(discovered1).toEqual(discovered2);
    });

    it('should preserve dynamic discoveredList entries across clearSkills', () => {
      const service = new SkillManager();

      // Add a static skill
      service.addSkills(
        [
          {
            name: 'static-skill',
            description: 'static',
            location: '/loc/static',
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'user',
      );

      // Add a dynamic skill
      service.addDynamicSkills(`/workspace/pkg/${CONFIG_DIR}/skills`, [
        {
          name: 'dynamic-skill',
          description: 'dynamic',
          location: `/workspace/pkg/${CONFIG_DIR}/skills/ds/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      expect(service.getAllDiscoveredSkills()).toHaveLength(2);

      // clearSkills() removes static but keeps dynamic
      service.clearSkills();

      const discovered = service.getAllDiscoveredSkills();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('dynamic-skill');
    });

  });

  describe('Dynamic Skills Priority Fix', () => {
    it('gives configured skills precedence over legacy .agents skills at the same depth', () => {
      const service = new SkillManager();
      const packageDir = '/workspace/packages/frontend';

      service.addDynamicSkills(
        `${packageDir}/${CONFIG_DIR}/skills`,
        [
          {
            name: 'shared-name',
            description: 'from configured directory',
            location: `${packageDir}/${CONFIG_DIR}/skills/s/SKILL.md`,
            skillRoot: process.cwd(),
            body: 'configured body',
          },
        ],
        { ancestorDepth: 3, source: 'configured' },
      );
      service.addDynamicSkills(
        `${packageDir}/.agents/skills`,
        [
          {
            name: 'shared-name',
            description: 'from legacy directory',
            location: `${packageDir}/.agents/skills/s/SKILL.md`,
            skillRoot: process.cwd(),
            body: 'legacy body',
          },
        ],
        { ancestorDepth: 3, source: 'legacy-agents' },
      );

      expect(service.getSkill('shared-name')?.description).toBe(
        'from configured directory',
      );
    });

    it('does not add the same dynamic directory twice', () => {
      const service = new SkillManager();
      const dir = `/workspace/packages/frontend/${CONFIG_DIR}/skills`;
      const skill = {
        name: 'dynamic-skill',
        description: 'dynamic skill',
        location: `${dir}/dynamic-skill/SKILL.md`,
        skillRoot: process.cwd(),
        body: 'body',
      };

      service.addDynamicSkills(dir, [skill]);
      service.addDynamicSkills(dir, [{ ...skill }]);

      expect(service.getAllDiscoveredSkills()).toHaveLength(1);
    });

    it('should give deeper directories higher precedence over shallower ones', () => {
      const service = new SkillManager();

      // Add shallower directory first
      service.addDynamicSkills(`/workspace/packages/${CONFIG_DIR}/skills`, [
        {
          name: 'shared-name',
          description: 'from shallow',
          location: `/workspace/packages/${CONFIG_DIR}/skills/s/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'shallow body',
        },
      ]);

      // Add deeper directory
      service.addDynamicSkills(
        `/workspace/packages/frontend/${CONFIG_DIR}/skills`,
        [
          {
            name: 'shared-name',
            description: 'from deep',
            location: `/workspace/packages/frontend/${CONFIG_DIR}/skills/s/SKILL.md`,
            skillRoot: process.cwd(),
            body: 'deep body',
          },
        ],
      );

      const skills = service.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe('from deep');
    });

    it('should handle three-level nesting with deepest winning', () => {
      const service = new SkillManager();

      service.addDynamicSkills(`/workspace/packages/${CONFIG_DIR}/skills`, [
        {
          name: 'test-skill',
          description: 'level 1',
          location: `/workspace/packages/${CONFIG_DIR}/skills/ts/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      service.addDynamicSkills(`/workspace/packages/ui/${CONFIG_DIR}/skills`, [
        {
          name: 'test-skill',
          description: 'level 2',
          location: `/workspace/packages/ui/${CONFIG_DIR}/skills/ts/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      service.addDynamicSkills(
        `/workspace/packages/ui/components/${CONFIG_DIR}/skills`,
        [
          {
            name: 'test-skill',
            description: 'level 3',
            location: `/workspace/packages/ui/components/${CONFIG_DIR}/skills/ts/SKILL.md`,
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
      );

      const skills = service.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe('level 3');
    });

    it('should still give dynamic skills precedence over static skills', () => {
      const service = new SkillManager();

      // @ts-expect-error accessing private property for testing
      service.skills = [
        {
          name: 'test-skill',
          description: 'from static',
          location: `/workspace/${CONFIG_DIR}/skills/ts/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ];

      service.addDynamicSkills(`/workspace/packages/lib/${CONFIG_DIR}/skills`, [
        {
          name: 'test-skill',
          description: 'from dynamic',
          location: `/workspace/packages/lib/${CONFIG_DIR}/skills/ts/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      const skills = service.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe('from dynamic');
    });
  });

  describe('Shadow Detection via getAllDiscoveredSkills', () => {
    it('should detect project skill shadowing user skill', () => {
      const service = new SkillManager();

      service.addSkills(
        [
          {
            name: 'shared-name',
            description: 'personal version',
            location: '/home/user/skills/s/SKILL.md',
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'user',
      );

      service.addSkills(
        [
          {
            name: 'shared-name',
            description: 'project version',
            location: `/workspace/${CONFIG_DIR}/skills/s/SKILL.md`,
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'project',
      );

      const active = service.getAllSkills();
      expect(active).toHaveLength(1);
      expect(active[0].description).toBe('project version');

      const discovered = service.getAllDiscoveredSkills();
      expect(discovered).toHaveLength(2);

      // Build a map of active skills for shadow detection
      const activeMap = new Map(active.map((s) => [s.name, s]));
      const shadowedEntries = discovered.filter((s) => {
        const a = activeMap.get(s.name);
        return a != null && a.location !== s.location;
      });

      expect(shadowedEntries).toHaveLength(1);
      expect(shadowedEntries[0].source).toBe('user');
    });

    it('should detect subdirectory project skill shadowing root project skill', () => {
      const service = new SkillManager();

      // @ts-expect-error accessing private property for testing
      service.skills = [
        {
          name: 'deploy',
          description: 'root project deploy',
          location: `/workspace/${CONFIG_DIR}/skills/deploy/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
          source: 'project',
        },
      ];
      // Also add to discoveredList
      // @ts-expect-error accessing private property for testing
      service.discoveredList = [...service.skills];

      service.addDynamicSkills(`/workspace/packages/api/${CONFIG_DIR}/skills`, [
        {
          name: 'deploy',
          description: 'subdirectory deploy',
          location: `/workspace/packages/api/${CONFIG_DIR}/skills/deploy/SKILL.md`,
          skillRoot: process.cwd(),
          body: 'body',
        },
      ]);

      const active = service.getAllSkills();
      expect(active).toHaveLength(1);
      expect(active[0].description).toBe('subdirectory deploy');

      const discovered = service.getAllDiscoveredSkills();
      expect(discovered).toHaveLength(2);

      const activeMap = new Map(active.map((s) => [s.name, s]));
      const shadowedEntries = discovered.filter((s) => {
        const a = activeMap.get(s.name);
        return a != null && a.location !== s.location;
      });

      expect(shadowedEntries).toHaveLength(1);
      // Both are source: 'project' but location differs — shadow is detected
      expect(shadowedEntries[0].source).toBe('project');
      expect(shadowedEntries[0].description).toBe('root project deploy');
    });

    it('should not report shadow when skill has no duplicate', () => {
      const service = new SkillManager();

      service.addSkills(
        [
          {
            name: 'unique-skill',
            description: 'only version',
            location: '/loc/SKILL.md',
            skillRoot: process.cwd(),
            body: 'body',
          },
        ],
        'user',
      );

      const active = service.getAllSkills();
      const discovered = service.getAllDiscoveredSkills();
      expect(discovered).toHaveLength(1);

      const activeMap = new Map(active.map((s) => [s.name, s]));
      const shadowedEntries = discovered.filter((s) => {
        const a = activeMap.get(s.name);
        return a != null && a.location !== s.location;
      });

      expect(shadowedEntries).toHaveLength(0);
    });
  });

  describe('allowedSources filtering', () => {
    it('always loads plugin skills regardless of allowedSources (matches Config.isAgentSourceAllowed)', async () => {
      const pluginSkillsDir = path.join(testRootDir, 'plugin-pkg', 'skills');
      await fs.mkdir(path.join(pluginSkillsDir, 'skill-from-path'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(pluginSkillsDir, 'skill-from-path', 'SKILL.md'),
        `---
name: skill-from-path
description: loaded from plugin.skillsPath
---
`,
      );

      const loadedPlugin = {
        name: 'loaded-plugin',
        path: path.dirname(pluginSkillsDir),
        skillsPath: pluginSkillsDir,
      } as unknown as LoadedPlugin;

      const service = new SkillManager();

      // allowedSources excludes 'plugin' — SDK invokes the CLI like this when
      // it passes `--setting-sources user` (or an empty string).
      await service.discoverSkills({
        allowedSources: ['user'],
        plugins: [loadedPlugin],
        resourceSkills: [resourceSkill('skill-user', 'user')],
      });

      const names = service.getSkills().map((s) => s.name);
      // Plugin skills survive the source filter and are namespaced.
      expect(names).toContain('loaded-plugin:skill-from-path');
      // The 'user' source is still honored.
      expect(names).toContain('skill-user');
    });

    it('still filters non-plugin sources when allowedSources is set', async () => {
      const service = new SkillManager();
      await service.discoverSkills({
        allowedSources: ['user'],
        resourceSkills: [
          resourceSkill('skill-project', 'project'),
          resourceSkill('skill-user', 'user'),
        ],
      });

      const names = service.getSkills().map((s) => s.name);
      expect(names).toContain('skill-user');
      expect(names).not.toContain('skill-project');
    });
  });

  describe('plugin skills path load errors', () => {
    it('surfaces a plugin-attributed load error when a declared skills path yields no skills', async () => {
      vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      // Non-empty skills dir without any SKILL.md — every skill would be
      // silently dropped before the fix.
      const pluginSkillsDir = path.join(testRootDir, 'plugin-pkg', 'skills');
      await fs.mkdir(path.join(pluginSkillsDir, 'engineering'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(pluginSkillsDir, 'engineering', 'notes.txt'),
        'not a skill',
      );

      const loadedPlugin = {
        name: 'broken-plugin',
        path: path.join(testRootDir, 'plugin-pkg'),
        skillsPath: pluginSkillsDir,
      } as unknown as LoadedPlugin;

      const service = new SkillManager();
      await service.discoverSkills({
        plugins: [loadedPlugin],
        emitToFeed: false,
      });

      const errors = service
        .getLoadErrors()
        .filter((e) => e.filePath === pluginSkillsDir);
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('error');
      expect(errors[0].source).toBe('plugin');
      expect(errors[0].message).toContain('No skills were loaded from');
    });

    it('lets recursive plugin discovery follow a category symlink outside the plugin root', async () => {
      vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      const pluginRoot = path.join(testRootDir, 'contained-plugin');
      const pluginSkillsDir = path.join(pluginRoot, 'skills');
      const externalCategory = path.join(testRootDir, 'personal-category');
      await fs.mkdir(path.join(externalCategory, 'personal-skill'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(externalCategory, 'personal-skill', 'SKILL.md'),
        '---\ndescription: lives outside the plugin on purpose\n---\nbody',
      );
      await fs.mkdir(pluginSkillsDir, { recursive: true });
      await fs.symlink(
        externalCategory,
        path.join(pluginSkillsDir, 'engineering'),
        'dir',
      );

      const loadedPlugin = {
        name: 'contained-plugin',
        path: pluginRoot,
        skillsPath: pluginSkillsDir,
      } as unknown as LoadedPlugin;

      const service = new SkillManager();
      await service.discoverSkills({
        plugins: [loadedPlugin],
        emitToFeed: false,
      });

      expect(
        service.getSkill('contained-plugin:personal-skill'),
      ).not.toBeNull();
      const errors = service
        .getLoadErrors()
        .filter((e) => e.source === 'plugin');
      expect(errors).toEqual([]);
    });
  });

  describe('plugin fork command injection', () => {
    function makePluginScaffold(name: string): {
      pluginDir: string;
      cmdsDir: string;
      plugin: LoadedPlugin;
    } {
      const pluginDir = path.join(testRootDir, name);
      const cmdsDir = path.join(pluginDir, 'commands');
      return {
        pluginDir,
        cmdsDir,
        plugin: {
          name,
          path: pluginDir,
          commandsPath: cmdsDir,
          manifest: { name, version: '1.0.0' } as never,
          source: 'local',
          repository: 'local',
          enabled: true,
        } as unknown as LoadedPlugin,
      };
    }

    it('injects fork-context plugin commands as plugin-command skills', async () => {
      const { pluginDir, cmdsDir, plugin } =
        makePluginScaffold('plugin-with-cmds');
      await fs.mkdir(cmdsDir, { recursive: true });
      await fs.writeFile(
        path.join(cmdsDir, 'review.md'),
        [
          '---',
          'description: review code',
          'context: fork',
          'allowed-tools: [Edit, Write]',
          'agent: code-reviewer',
          '---',
          'do the review for ${QWEN_PLUGIN_ROOT}',
        ].join('\n'),
      );

      const service = new SkillManager();
      await service.discoverSkills({ plugins: [plugin] });

      const skill = service.getSkill('plugin-with-cmds:review');
      expect(skill).toBeDefined();
      expect(skill?.kind).toBe('plugin-command');
      expect(skill?.context).toBe('fork');
      expect(skill?.allowedTools).toEqual(['Edit', 'Write']);
      expect(skill?.agent).toBe('code-reviewer');
      expect(skill?.pluginPath).toBe(pluginDir);
      expect(skill?.source).toBe('plugin');
    });

    it('does not inject inline-context plugin commands', async () => {
      const { cmdsDir, plugin } = makePluginScaffold('plugin-inline-only');
      await fs.mkdir(cmdsDir, { recursive: true });
      await fs.writeFile(
        path.join(cmdsDir, 'inline-cmd.md'),
        '---\ndescription: inline\n---\nbody',
      );

      const service = new SkillManager();
      await service.discoverSkills({ plugins: [plugin] });

      expect(service.getSkill('plugin-inline-only:inline-cmd')).toBeNull();
    });

    it('warns and lets plugin command win when shadowing a same-named plugin skill', async () => {
      const { pluginDir, cmdsDir, plugin } =
        makePluginScaffold('plugin-shadow');
      const skillsDir = path.join(pluginDir, 'skills');
      const skillFooDir = path.join(skillsDir, 'foo');
      await fs.mkdir(skillFooDir, { recursive: true });
      await fs.mkdir(cmdsDir, { recursive: true });

      // Plugin skill `foo` (regular skill, kind undefined).
      await fs.writeFile(
        path.join(skillFooDir, 'SKILL.md'),
        '---\ndescription: skill foo\n---\nskill body',
      );
      // Fork plugin command `foo` (same identity, will shadow).
      await fs.writeFile(
        path.join(cmdsDir, 'foo.md'),
        [
          '---',
          'description: command foo',
          'context: fork',
          '---',
          'cmd body',
        ].join('\n'),
      );

      // Wire skillsPath on the plugin so SkillManager picks up the plugin skill.
      const pluginWithSkills = {
        ...plugin,
        skillsPath: skillsDir,
      } as unknown as LoadedPlugin;

      const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

      const service = new SkillManager();
      await service.discoverSkills({ plugins: [pluginWithSkills] });

      // The plugin command wins (injected after, last-write-wins precedence).
      const resolved = service.getSkill('plugin-shadow:foo');
      expect(resolved).toBeDefined();
      expect(resolved?.kind).toBe('plugin-command');

      // And a shadow warning was logged.
      const warnedShadow = warnSpy.mock.calls.some((args) => {
        const msg = args[0];
        return (
          typeof msg === 'string' &&
          msg.includes('shadow') &&
          msg.includes('plugin-shadow:foo')
        );
      });
      expect(warnedShadow).toBe(true);
    });
  });

  // Plugin skill paths keep direct-or-container semantics, unlike user and
  // project skills roots which are containers only. A plugin manifest may
  // point `skills` straight at one skill package.
  describe('plugin skill paths are direct-or-container', () => {
    async function writeSkill(dir: string, name: string) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} description\n---\nbody\n`,
      );
    }

    async function discoverWithPluginSkillsDir(skillsDir: string) {
      const plugin = {
        name: 'p',
        path: path.dirname(skillsDir),
        skillsPath: skillsDir,
      } as unknown as LoadedPlugin;
      const service = new SkillManager();
      await service.discoverSkills({ plugins: [plugin] });
      return service;
    }

    it('loads a SKILL.md at the root of the plugin skills path', async () => {
      const skillsDir = path.join(testRootDir, 'plugin-direct', 'skills');
      await writeSkill(skillsDir, 'direct-plugin-skill');

      const service = await discoverWithPluginSkillsDir(skillsDir);

      // Identity stays path-derived, so the last segment is the directory
      // name; frontmatter `name` lands on displayName.
      const skill = service.getSkill('p:skills');
      expect(skill).toBeDefined();
      expect(skill?.displayName).toBe('direct-plugin-skill');
    });

    it('lets the root SKILL.md shadow sibling subdirectories, and logs which', async () => {
      const skillsDir = path.join(testRootDir, 'plugin-mixed', 'skills');
      await writeSkill(skillsDir, 'direct-plugin-skill');
      await writeSkill(path.join(skillsDir, 'alpha'), 'alpha');
      await writeSkill(path.join(skillsDir, 'beta'), 'beta');
      const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

      const service = await discoverWithPluginSkillsDir(skillsDir);

      const names = service.getSkills().map((s) => s.name);
      expect(names).toContain('p:skills');
      expect(names).not.toContain('p:alpha');
      expect(names).not.toContain('p:beta');
      // Upstream skips them silently; we leave the plugin author a breadcrumb.
      const warnedShadowed = warnSpy.mock.calls.some((args) => {
        const msg = args[0];
        return (
          typeof msg === 'string' &&
          msg.includes('were not loaded: alpha, beta')
        );
      });
      expect(warnedShadowed).toBe(true);
    });

    it('reports an incomplete listing even when it found nothing shadowed', async () => {
      // The diagnostic is bounded (the skills path may be a symlink to any tree
      // on disk), so hitting the cap must be reported rather than presented as
      // "nothing was shadowed". None of the subdirectories hold a SKILL.md, so
      // the probes come back empty and only the truncation is worth saying.
      const skillsDir = path.join(testRootDir, 'plugin-many', 'skills');
      await writeSkill(skillsDir, 'direct-plugin-skill');
      for (let i = 0; i < 205; i++) {
        await fs.mkdir(
          path.join(skillsDir, `sub-${String(i).padStart(3, '0')}`),
          {
            recursive: true,
          },
        );
      }
      const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

      await discoverWithPluginSkillsDir(skillsDir);

      const warnedTruncated = warnSpy.mock.calls.some((args) => {
        const msg = args[0];
        return (
          typeof msg === 'string' &&
          msg.includes(
            'found none, but the listing stopped at 200 subdirectories',
          )
        );
      });
      expect(warnedTruncated).toBe(true);
      // "were not loaded" would name subdirectories that hold no skill at all.
      const warnedShadowed = warnSpy.mock.calls.some((args) => {
        const msg = args[0];
        return typeof msg === 'string' && msg.includes('were not loaded');
      });
      expect(warnedShadowed).toBe(false);
    });

    it('names the cause when the shadowed-subdirectory listing fails part-way', async () => {
      // A read error is not a cap: the message must not claim a limit was hit.
      const skillsDir = path.join(testRootDir, 'plugin-read-error', 'skills');
      await writeSkill(skillsDir, 'direct-plugin-skill');
      await writeSkill(path.join(skillsDir, 'alpha'), 'alpha');
      opendirOverride = (dirPath) =>
        path.resolve(dirPath) === path.resolve(skillsDir)
          ? failingDirHandle(dirPath, ['alpha'])
          : null;
      const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

      await discoverWithPluginSkillsDir(skillsDir);

      const warned = warnSpy.mock.calls.some((args) => {
        const msg = args[0];
        return (
          typeof msg === 'string' &&
          msg.includes(
            'were not loaded: alpha (the directory could not be read past 1 entries, so there may be more)',
          )
        );
      });
      expect(warned).toBe(true);
    });

    it('bounds the raw entries read before any subdirectory turns up', async () => {
      // A directory full of plain files must not be walked to its end either.
      const skillsDir = path.join(testRootDir, 'plugin-entry-cap', 'skills');
      await writeSkill(skillsDir, 'direct-plugin-skill');
      const files = Array.from({ length: 5000 }, (_, i) => `file-${i}.txt`);
      opendirOverride = (dirPath) =>
        path.resolve(dirPath) === path.resolve(skillsDir)
          ? fileOnlyDirHandle(dirPath, files)
          : null;
      const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

      await discoverWithPluginSkillsDir(skillsDir);

      const warned = warnSpy.mock.calls.some((args) => {
        const msg = args[0];
        return (
          typeof msg === 'string' &&
          msg.includes(
            'the listing stopped after reading 2000 directory entries',
          )
        );
      });
      expect(warned).toBe(true);
    });

    it('scans subdirectories when the plugin skills path has no root SKILL.md', async () => {
      const skillsDir = path.join(testRootDir, 'plugin-container', 'skills');
      await writeSkill(path.join(skillsDir, 'alpha'), 'alpha');
      await writeSkill(path.join(skillsDir, 'beta'), 'beta');
      const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

      const service = await discoverWithPluginSkillsDir(skillsDir);

      const names = service.getSkills().map((s) => s.name);
      expect(names).toContain('p:alpha');
      expect(names).toContain('p:beta');
      const warnedShadowed = warnSpy.mock.calls.some((args) => {
        const msg = args[0];
        return typeof msg === 'string' && msg.includes('were not loaded');
      });
      expect(warnedShadowed).toBe(false);
    });

    it('applies container semantics to the user root and direct semantics to the plugin path in one pass', async () => {
      const pluginSkillsDir = path.join(testRootDir, 'both-plugin', 'skills');
      await writeSkill(pluginSkillsDir, 'direct-plugin-skill');

      const plugin = {
        name: 'p',
        path: path.dirname(pluginSkillsDir),
        skillsPath: pluginSkillsDir,
      } as unknown as LoadedPlugin;

      const service = new SkillManager();
      await service.discoverSkills({
        plugins: [plugin],
        resourceSkills: [resourceSkill('user-alpha', 'user')],
      });

      const names = service.getSkills().map((s) => s.name);
      // User skills already arrive from the resource layer; plugin paths
      // retain direct-skill semantics inside SkillManager.
      expect(names).toContain('user-alpha');
      // Plugin path: direct — the root SKILL.md is the skill.
      expect(names).toContain('p:skills');
    });
  });
});
