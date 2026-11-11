/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `init.skills` 快照的可见性过滤。
 *
 * 这张网钉的是一个真实回归：会话级 allowlist（`options.skills`）已经通过
 * `setSessionSkillAllowlist` 正确设进了 SkillManager，但初始快照这一处只按
 * `skillOverrides='off'` 过滤，漏了 `isSkillAllowedForMainSession`，于是未列入
 * allowlist 的项目 Skill 照样出现在 `init.skills` 里。热加载路径本来就是对的
 * （`reloadSkills` 走 `buildSdkSkillSnapshot`，那份带 allowlist 过滤），所以
 * 「三份快照里持续不可见」这条 e2e 是在**第一份**上就红的。
 *
 * 过滤条件必须与 worker 逐字对齐（`headlessSession.ts:1922-1928`）：两个条件是
 * **与**关系，任一命中就隐藏。
 */

import { describe, expect, it, vi } from 'vitest';
import { Config, type PermissionPolicySnapshot, type PermissionMode } from '@qwen-code/core';
import { createPermissionManager } from '../../../../../core/src/test-utils/config.js';
import { buildSessionInitializeSnapshot, buildSessionPermissionPolicy } from './sessionInitializeSnapshot.js';

// 这张网只关心 skill 过滤；命令快照用最小桩，fake config 不必撑起整个 CommandService。
vi.mock('../../../sdkCommandCatalog.js', () => ({
  buildSdkCommandSnapshot: async () => [],
}));

interface FakeSkill {
  name: string;
  description: string;
  source?: string;
}

function fakeSkillManager(options: {
  skills: FakeSkill[];
  hidden?: readonly string[];
  allowlist?: readonly string[];
}) {
  const hidden = new Set(options.hidden ?? []);
  // allowlist 为 undefined 表示「没设会话级白名单」，此时一律放行——
  // 与 SkillManager.isSkillAllowedForMainSession 的语义一致。
  const allow = options.allowlist === undefined ? null : new Set(options.allowlist);
  return {
    getSkills: () => options.skills,
    getSkillVisibilityOverride: (name: string) =>
      hidden.has(name) ? 'off' : undefined,
    isSkillAllowedForMainSession: (name: string) =>
      allow === null ? true : allow.has(name),
  };
}

function fakeConfig(skillManager: unknown): Config {
  return {
    getAvailableOutputStyles: async () => ({ default: null }),
    getAgentRegistry: () => undefined,
    getSkillManager: () => skillManager,
    getOutputStyle: () => undefined,
    getPermissionMode: () => 'default',
    getPermissionModeRestriction: () => undefined,
  } as unknown as Config;
}

const SKILLS: FakeSkill[] = [
  { name: 'allowed-skill', description: 'in allowlist', source: 'project' },
  { name: 'blocked-skill', description: 'not in allowlist', source: 'project' },
  { name: 'off-skill', description: 'visibility off', source: 'project' },
];

async function snapshotOf(skillManager: unknown) {
  // 骨架的 buildSessionInitializeSnapshot 第二参只有 { includePermissionMode? }，没有
  // commandCatalog（那是封存分支镜像层的入参，骨架不带）。Skill 可见性/allowlist 过滤
  // 不依赖命令目录，直接走默认空 options 即可，断言目标与封存分支一致。
  return buildSessionInitializeSnapshot(fakeConfig(skillManager));
}

function namesOf(skills: ReadonlyArray<{ name: string }>): string[] {
  return skills.map((skill) => skill.name);
}

describe('init.skills 快照过滤', () => {
  it('会话级 allowlist 生效：未列入的 Skill 不出现在初始快照里', async () => {
    const snapshot = await snapshotOf(
      fakeSkillManager({
        skills: SKILLS,
        allowlist: ['allowed-skill', 'off-skill'],
      }),
    );

    expect(namesOf(snapshot.skills)).toEqual(['allowed-skill', 'off-skill']);
  });

  it("skillOverrides='off' 仍然隐藏，即使该 Skill 在 allowlist 里", async () => {
    const snapshot = await snapshotOf(
      fakeSkillManager({
        skills: SKILLS,
        hidden: ['off-skill'],
        allowlist: ['allowed-skill', 'blocked-skill', 'off-skill'],
      }),
    );

    expect(namesOf(snapshot.skills)).toEqual(['allowed-skill', 'blocked-skill']);
  });

  it('两个条件是「与」关系：allowlist 外且被 off 的都不出现', async () => {
    const snapshot = await snapshotOf(
      fakeSkillManager({
        skills: SKILLS,
        hidden: ['off-skill'],
        allowlist: ['allowed-skill'],
      }),
    );

    expect(namesOf(snapshot.skills)).toEqual(['allowed-skill']);
  });

  it('没设会话级 allowlist 时不因这次修复而少给 Skill', async () => {
    const snapshot = await snapshotOf(
      fakeSkillManager({ skills: SKILLS, hidden: ['off-skill'] }),
    );

    expect(namesOf(snapshot.skills)).toEqual(['allowed-skill', 'blocked-skill']);
  });

  it('保留 source 与 description 投影', async () => {
    const snapshot = await snapshotOf(
      fakeSkillManager({ skills: SKILLS, allowlist: ['allowed-skill'] }),
    );

    expect(snapshot.skills).toEqual([
      {
        name: 'allowed-skill',
        description: 'in allowlist',
        source: 'project',
      },
    ]);
  });
});


describe('effective permission policy snapshot', () => {
  it.each<[boolean, PermissionPolicySnapshot | undefined, string[]]>([
    [false, undefined, []],
    [true, { disabledModes: [] }, []],
    [true, undefined, []],
    [true, { disabledModes: ['yolo'], disabledModeMessages: { yolo: 'managed reason' } }, ['yolo']],
  ])('matches execution restrictions (configured=%s, policy=%j)', (configured, policy, expected) => {
    const source = configured ? {
      start: async () => {}, stop: async () => {},
      getValue: <T>() => policy as T,
      onValueChange: () => () => {}, onError: () => () => {},
    } : undefined;
    const context = {
      permission: createPermissionManager({
        cwd: '/repo',
        organizationPolicy: source,
        checkerDeps: {
          skill: { isAllowedForMainSession: () => true, isDisabled: () => false, hasOnlySafeProperties: () => false },
          mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
        },
      }),
    } as unknown as Config;
    const config = {
      getPermissionModeRestriction: (mode: PermissionMode) =>
        Config.prototype.getPermissionModeRestriction.call(context, mode),
    };
    const snapshot = buildSessionPermissionPolicy(config);
    expect([...snapshot.disabledModes].sort()).toEqual([...expected].sort());
    for (const mode of snapshot.disabledModes) {
      expect(snapshot.disabledModeMessages?.[mode]).toBe(
        config.getPermissionModeRestriction(mode as PermissionMode),
      );
    }
  });
});
