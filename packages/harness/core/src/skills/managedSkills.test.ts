/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillManager } from './skillManager.js';
import type { ManagedSkillResource } from '../config/managedResources.js';
import type { SkillDefinition } from '@qwen-code/resource';

let root: string;
let resource: ManagedSkillResource;
let manager: SkillManager;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'managed-skills-'));
  const filePath = join(root, 'SKILL.md');
  await writeFile(
    filePath,
    '---\nname: Display title\ndescription: Review changes\n---\nReview supporting files.',
  );
  resource = {
    id: 's1',
    name: 'review',
    filePath,
    sourceId: 'identity',
    userVisible: true,
    userCanDisable: true,
    disabled: false,
  };
  manager = new SkillManager();
  manager.setDisableBuiltinSkills(true);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const ordinary = (name = 'review'): SkillDefinition => ({
  name,
  description: 'ordinary',
  location: '/ordinary/SKILL.md',
  skillRoot: '/ordinary',
  body: 'ordinary',
  source: 'user',
});

describe('managed Skill discovery', () => {
  it('overrides normalized static, bundled and dynamic names, restoring ordinary candidates after withdrawal', async () => {
    await manager.discoverSkills({
      resourceSkills: [ordinary('REVIEW')],
      managedSkills: [resource],
    });
    manager.addDynamicSkills('/dynamic', [ordinary('Review')]);
    expect(
      manager
        .getAllSkills()
        .filter((skill) => skill.name.toLowerCase() === 'review'),
    ).toHaveLength(1);
    expect(manager.getSkill('review')).toMatchObject({
      displayName: 'Display title',
      managed: { id: 's1' },
    });
    await manager.discoverSkills({
      resourceSkills: [ordinary('REVIEW')],
      managedSkills: [],
    });
    expect(manager.getSkill('Review')?.body).toBe('ordinary');
  });

  it('keeps the last case-insensitive managed winner and its insertion order', async () => {
    await manager.discoverSkills({
      resourceSkills: [ordinary('keep'), ordinary('REVIEW')],
      managedSkills: [
        resource,
        { ...resource, id: 's2', name: 'middle' },
        { ...resource, id: 's3', name: 'Review' },
      ],
    });
    manager.addDynamicSkills('/dynamic', [ordinary('review')]);
    expect(manager.getAllSkills().map((skill) => skill.name)).toEqual([
      'keep',
      'middle',
      'Review',
    ]);
    expect(manager.getSkill('Review')?.managed?.id).toBe('s3');
  });

  it('does not let ordinary disabled settings disable a locked managed candidate', async () => {
    await manager.discoverSkills({
      managedSkills: [{ ...resource, userCanDisable: false, disabled: true }],
    });
    manager.setDisabledSkills(['review']);
    expect(manager.getSkill('review')?.disabled).toBe(false);
    expect(manager.getSkills().map((skill) => skill.name)).toContain('review');
  });

  it('uses the enterprise disable preference rather than ordinary name settings', async () => {
    await manager.discoverSkills({ managedSkills: [resource] });
    manager.setDisabledSkills(['review']);
    expect(manager.getSkill('review')?.disabled).toBe(false);
    await manager.discoverSkills({
      managedSkills: [{ ...resource, disabled: true }],
    });
    expect(manager.getSkill('review')?.disabled).toBe(true);
  });

  it('hides user management without hiding model execution', async () => {
    await manager.discoverSkills({
      managedSkills: [{ ...resource, userVisible: false, disabled: true }],
    });
    expect(manager.getDisplayableSkills()).toEqual([]);
    expect(manager.getAllDiscoveredSkills()).toEqual([]);
    expect(manager.getSkills().map((skill) => skill.name)).toContain('review');
  });

  it('keeps frontmatter invocation constraints and explicit session allowlists', async () => {
    await writeFile(
      resource.filePath,
      '---\ndescription: Review\ndisable-model-invocation: true\nuser-invocable: false\n---\nReview.',
    );
    await manager.discoverSkills({ managedSkills: [resource] });
    expect(manager.getSkill('review')).toMatchObject({
      disableModelInvocation: true,
      userInvocable: false,
    });
    expect(manager.getDisplayableSkills()).toEqual([]);
    manager.setSessionSkillAllowlist(['other']);
    expect(manager.isSkillAllowedForMainSession('review')).toBe(false);
  });
});
