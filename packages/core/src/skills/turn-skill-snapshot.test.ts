/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { SkillTool } from '../tools/skill.js';
import { collectAvailableSkillEntries } from '../tools/skill-utils.js';
import { partToString } from '../utils/partUtils.js';
import * as paths from '../utils/paths.js';
import { SkillManager } from './skill-manager.js';
import {
  getTurnSkillSourcePath,
  prepareTurnSkillSnapshot,
  runWithTurnSkillSnapshot,
  type TurnSkillSnapshotLease,
} from './turn-skill-snapshot.js';
import type { SkillConfig } from './types.js';

const runFile = promisify(execFile);

describe('turn skill snapshot', () => {
  let source: string;
  let skillDirectory: string;
  let snapshots: string;
  let leases: TurnSkillSnapshotLease[];

  beforeEach(async () => {
    source = await fs.mkdtemp(path.join(tmpdir(), 'turn-snapshot-test-'));
    skillDirectory = path.join(source, 'skill');
    snapshots = path.join(source, 'snapshots');
    await fs.mkdir(skillDirectory);
    leases = [];
  });

  afterEach(async () => {
    await Promise.all(leases.map((lease) => lease.dispose()));
    await fs.rm(source, { recursive: true, force: true });
  });

  async function publish(text: string, script = text): Promise<SkillConfig> {
    const filePath = path.join(skillDirectory, 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---\nname: sample\ndescription: Fixture\n---\n${text}\n`,
    );
    await fs.writeFile(
      path.join(skillDirectory, 'script.cjs'),
      `process.stdout.write(${JSON.stringify(script)});\n`,
    );
    return {
      name: 'fixture:sample',
      authoredName: 'sample',
      extensionName: 'fixture',
      level: 'extension',
      description: 'Fixture',
      body: text,
      filePath,
    };
  }

  async function capture(skill: SkillConfig, expectedDigest?: string) {
    const lease = await prepareTurnSkillSnapshot([skill], {
      baseDirectory: snapshots,
      expectedDigest,
    });
    leases.push(lease);
    return lease.snapshot;
  }

  function setupTool(initial: SkillConfig, bundled?: SkillConfig) {
    let discovered = initial;
    let enabled = true;
    const config = {
      getProjectRoot: () => source,
      getUsageStatisticsEnabled: () => false,
      getSessionId: () => 'snapshot-fixture',
      getDisabledSkillNames: () => new Set<string>(),
      getModelInvocableCommandsProvider: () => null,
      getModelInvocableCommandsExecutor: () => null,
      getPermissionManager: () => null,
      getHookSystem: () => null,
      isExplicitlyTrustedFolder: () => false,
      isSkillEnabled: (skill: SkillConfig) =>
        enabled &&
        (skill.filePath === initial.filePath ||
          skill.filePath === bundled?.filePath),
      getSkillManager: () => manager,
    } as unknown as Config;
    const manager = new SkillManager(config);
    vi.spyOn(manager, 'listSkills').mockImplementation(
      async ({ level } = {}) =>
        level === 'bundled' ? (bundled ? [bundled] : []) : [discovered],
    );
    vi.spyOn(manager, 'getCachedSkills').mockImplementation((level) =>
      level === 'bundled' ? (bundled ? [bundled] : []) : [discovered],
    );
    vi.spyOn(manager, 'loadSkill').mockImplementation(async (_name, level) =>
      level === 'bundled' ? (bundled ?? null) : discovered,
    );
    const tool = new SkillTool(config);
    return {
      tool,
      manager,
      config,
      replace: (skill: SkillConfig) => {
        discovered = skill;
      },
      disable: () => {
        enabled = false;
      },
    };
  }

  it('keeps a pending invocation on its original body and script while another turn runs a new revision', async () => {
    const v1 = await publish('body 1', 'script 1');
    const old = await capture(v1);
    const { tool, manager, config, replace } = setupTool(v1);
    let approve!: () => void;
    const approval = new Promise<void>((resolve) => {
      approve = resolve;
    });
    const params = { skill: v1.name };
    const oldResult = runWithTurnSkillSnapshot(old, async () => {
      const approved = tool.build(params);
      await approval;
      return approved.execute(new AbortController().signal);
    });

    const v2 = await publish('body 2', 'script 2');
    replace(v2);
    await tool.refreshSkills();
    const current = await capture(v2);
    expect(current.digest).not.toBe(old.digest);
    await runWithTurnSkillSnapshot(current, async () => {
      const result = await tool
        .build(params)
        .execute(new AbortController().signal);
      expect(partToString(result.llmContent)).toContain('body 2');
      expect(partToString(result.llmContent)).not.toContain('body 1');
      const skill = await manager.loadSkillForRuntime(v2.name);
      expect(skill?.filePath).toBe(current.skills[0]?.filePath);
      const { stdout } = await runFile(process.execPath, [
        path.join(path.dirname(skill!.filePath), 'script.cjs'),
      ]);
      expect(stdout).toBe('script 2');
      const repeated = await tool
        .build(params)
        .execute(new AbortController().signal);
      expect(partToString(repeated.llmContent)).toContain('already loaded');
    });

    approve();
    const result = await oldResult;
    expect(partToString(result.llmContent)).toContain('body 1');
    expect(partToString(result.llmContent)).not.toContain('body 2');
    expect(partToString(result.llmContent)).toContain(
      path.dirname(old.skills[0]!.filePath),
    );
    const { stdout } = await runFile(process.execPath, [
      path.join(path.dirname(old.skills[0]!.filePath), 'script.cjs'),
    ]);
    expect(stdout).toBe('script 1');

    const following = await capture(v2, current.digest);
    await runWithTurnSkillSnapshot(following, async () => {
      const next = await tool
        .build(params)
        .execute(new AbortController().signal);
      expect(partToString(next.llmContent)).toContain('body 2');
      expect(
        (await collectAvailableSkillEntries(manager, config)).entries,
      ).toEqual([expect.objectContaining({ name: v2.name })]);
    });
    expect(await manager.loadSkillForRuntime(v2.name)).toEqual(v2);
  });

  it('preserves unpinned bundled skills and the selected override priority', async () => {
    const extension = await publish('override body');
    const bundled: SkillConfig = {
      ...extension,
      level: 'bundled',
      body: 'bundled body',
      filePath: path.join(source, 'builtin', 'SKILL.md'),
    };
    const { tool } = setupTool(extension, bundled);
    const params = { skill: extension.name };
    const snapshot = await capture(extension);
    await runWithTurnSkillSnapshot(snapshot, async () => {
      const result = await tool
        .build(params)
        .execute(new AbortController().signal);
      expect(partToString(result.llmContent)).toContain('override body');
    });
    const empty = await prepareTurnSkillSnapshot([], {
      baseDirectory: snapshots,
    });
    leases.push(empty);
    await runWithTurnSkillSnapshot(empty.snapshot, async () => {
      const result = await tool
        .build(params)
        .execute(new AbortController().signal);
      expect(partToString(result.llmContent)).toContain('bundled body');
    });
  });

  it('reloads a Skill from its live directory after a pinned prompt', async () => {
    const skill = await publish('body 1');
    const snapshot = await capture(skill);
    const { tool } = setupTool(skill);
    await tool.refreshSkills();
    const invoke = () =>
      tool.build({ skill: skill.name }).execute(new AbortController().signal);
    const pinned = await runWithTurnSkillSnapshot(snapshot, invoke);
    expect(partToString(pinned.llmContent)).toContain(
      path.dirname(snapshot.skills[0]!.filePath),
    );
    await leases.pop()!.dispose();

    const live = partToString((await invoke()).llmContent);
    expect(live).toContain(path.dirname(skill.filePath));
    expect(live).toContain('body 1');
    expect(partToString((await invoke()).llmContent)).toContain(
      'already loaded',
    );
  });

  it('activates an unshadowed path-conditional bundled Skill in a pinned turn', async () => {
    const skill = await publish('body 1');
    const bundled: SkillConfig = {
      ...skill,
      name: 'builtin',
      level: 'bundled',
      paths: ['**/*.ts'],
      filePath: path.join(source, 'builtin', 'SKILL.md'),
    };
    const snapshot = await capture(skill);
    const { manager } = setupTool(skill, bundled);
    await runWithTurnSkillSnapshot(snapshot, async () => {
      expect(manager.isSkillActive(bundled)).toBe(false);
      expect(
        await manager.matchAndActivateByPath(path.join(source, 'test.ts')),
      ).toEqual(['builtin']);
      expect(manager.isSkillActive(bundled)).toBe(true);
    });
  });

  it('aliases only companion paths that still have their staged destination', async () => {
    const skill = await publish('body 1');
    const snapshot = await capture(skill);
    const staged = path.join(
      path.dirname(snapshot.skills[0]!.filePath),
      'script.cjs',
    );
    runWithTurnSkillSnapshot(snapshot, () => {
      expect(getTurnSkillSourcePath(staged)).toBe(
        path.join(skillDirectory, 'script.cjs'),
      );
      const resolve = vi
        .spyOn(paths, 'realpathNearestExisting')
        .mockReturnValue(path.join(source, 'replacement'));
      try {
        expect(getTurnSkillSourcePath(staged)).toBeUndefined();
      } finally {
        resolve.mockRestore();
      }
    });
  });

  it('rejects a digest if an empty companion directory was removed', async () => {
    const skill = await publish('body 1');
    const companion = path.join(skillDirectory, 'assets');
    await fs.mkdir(companion);
    const snapshot = await capture(skill);
    await fs.rmdir(companion);
    await expect(capture(skill, snapshot.digest)).rejects.toThrow(
      'expected digest',
    );
  });

  it('checks the original resource identity against current authorization after building a tool call', async () => {
    const skill = await publish('body 1');
    const pinned = await capture(skill);
    const { tool, disable } = setupTool(skill);
    await runWithTurnSkillSnapshot(pinned, async () => {
      expect(tool.validateToolParams({ skill: skill.name })).toBeNull();
      const invocation = tool.build({ skill: skill.name });
      disable();
      const result = await invocation.execute(new AbortController().signal);
      expect(partToString(result.llmContent)).toContain('disabled');
      expect(partToString(result.llmContent)).not.toContain(skill.body);
    });
  });

  it('rejects an unchanged body when its frontmatter changes after discovery', async () => {
    const discovered = await publish('unchanged body');
    await fs.writeFile(
      discovered.filePath,
      '---\nname: sample\ndescription: Fixture\ndisable-model-invocation: true\n---\nunchanged body\n',
    );
    await expect(capture(discovered)).rejects.toThrow(
      'Skill discovery changed',
    );
    expect(await fs.readdir(snapshots)).toEqual([]);
  });

  it('rejects attempted links outside the skill and removes partial staging', async () => {
    const skill = await publish('body 1');
    const outside = path.join(source, 'private.txt');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(skillDirectory, 'escape'));
    await expect(capture(skill)).rejects.toThrow('cannot follow links');
    expect(await fs.readdir(snapshots)).toEqual([]);
  });

  it('rejects a changed companion script even when discovery and body are unchanged', async () => {
    const skill = await publish('unchanged body', 'script 1');
    const previous = await capture(skill);
    const newer = await publish('unchanged body', 'script 2');
    await expect(capture(newer, previous.digest)).rejects.toThrow(
      'expected digest',
    );
    expect(await fs.readdir(snapshots)).toEqual([previous.id]);
  });
});
