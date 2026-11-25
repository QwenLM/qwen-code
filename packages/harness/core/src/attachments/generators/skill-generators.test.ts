/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@qwen-code/resource';
import { createAttachmentContext } from '../get-attachments.js';
import {
  getSkillListingAttachments,
  getSkillListingConfig,
  resetSkillListingState,
} from './skill-generators.js';

import { Config } from '../../config/config.js';
import { emptySnapshotSource } from '../../test-utils/listed-model.js';

const SKILL: SkillDefinition = {
  name: 'inspect',
  description: 'Inspect a repository',
  location: '/workspace/.qwen/skills/inspect/SKILL.md',
  skillRoot: '/workspace/.qwen/skills/inspect',
  body: 'Inspect the repository.',
};

describe('getSkillListingAttachments', () => {
  it.each([true, false])(
    'keeps short descriptions for a large catalog with workflows=%s',
    async (enabled) => {
      const config = {
        isWorkflowsEnabled: () => enabled,
        getModelProviderManager: emptySnapshotSource.getModelProviderManager,
        getSkillListingMaxDescChars: () =>
          Config.prototype.getSkillListingMaxDescChars.call({} as Config),
        getSkillListingBudgetFraction: () =>
          Config.prototype.getSkillListingBudgetFraction.call({} as Config),
        getSkillVisibilityOverrides: () => ({}),
        getSkillManager: () => ({
          getUsageScore: () => 0,
          getSkillVisibilityOverride: () => undefined,
        }),
        getModel: () => 'test-model',
        getEffectiveContextWindow: () => 256_000,
      } as unknown as Config;
      const options = await getSkillListingConfig(config);
      expect(options).toMatchObject({
        maxDescChars: 300,
        budgetFraction: 0.05,
        contextWindowTokens: 256_000,
      });
      const skills = Array.from({ length: 55 }, (_, i) => ({
        ...SKILL,
        name: `skill-${i}`,
        description: '描述'.repeat(800),
      }));
      const [listing] = await getSkillListingAttachments(
        createAttachmentContext('/workspace'),
        skills,
        true,
        options,
      );
      // 55 条中文简介在 5% 预算内均可发现，原始正文与描述不被改写。
      for (const skill of skills) {
        expect(listing.content).toContain(
          `- ${skill.name}: ${'描述'.repeat(149)}描…`,
        );
        expect(skill.description).toHaveLength(1600);
        expect(skill.body).toBe(SKILL.body);
      }
    },
  );

  it('counts the ellipsis inside explicit description limits and preserves exact boundaries', async () => {
    const [listing] = await getSkillListingAttachments(
      createAttachmentContext('/workspace'),
      [
        { ...SKILL, name: 'exact', description: 'abcd' },
        { ...SKILL, name: 'long', description: 'abcde' },
        { ...SKILL, name: 'combined', description: 'ab', whenToUse: 'cdef' },
        { ...SKILL, name: 'unicode', description: 'ab😀cd' },
      ],
      true,
      { maxDescChars: 4, budgetFraction: 1 },
    );
    expect(listing.content).toBe(
      '- exact: abcd\n- long: abc…\n- combined: ab …\n- unicode: ab…',
    );
  });

  it('keeps explicit configuration ahead of unified defaults', () => {
    const config = {
      skillListingMaxDescChars: 800,
      skillListingBudgetFraction: 0.2,
    } as unknown as Config;
    expect(Config.prototype.getSkillListingMaxDescChars.call(config)).toBe(800);
    expect(Config.prototype.getSkillListingBudgetFraction.call(config)).toBe(
      0.2,
    );
  });

  it('only appends unseen names during ordinary interactive turns', async () => {
    const ctx = createAttachmentContext('/workspace');
    const config = { preserveNames: true };
    const list = (names: string[], initial = false) =>
      getSkillListingAttachments(
        ctx,
        names.map((name) => ({ ...SKILL, name })),
        initial,
        config,
      );

    expect(await list([], true)).toEqual([]);
    expect(await list(['a', 'b'])).toMatchObject([
      { names: ['a', 'b'], isInitial: true },
    ]);
    const sent = ctx.sentSkillNames.get('main');
    expect(await list(['a'])).toEqual([]);
    expect(await list([])).toEqual([]);
    expect(await list(['a', 'b'])).toEqual([]);
    expect(await list(['a', 'c'])).toMatchObject([
      { names: ['c'], isInitial: false },
    ]);
    expect(ctx.sentSkillNames.get('main')).toBe(sent);
    expect([...sent!]).toEqual(['a', 'b', 'c']);
  });

  it('uses restored names, isolates child scopes and resends after an explicit reset', async () => {
    const ctx = createAttachmentContext('/workspace');
    ctx.sentSkillNames.set('main', new Set(['a']));
    const skills = ['a', 'b'].map((name) => ({ ...SKILL, name }));
    const config = { preserveNames: true };

    expect(
      await getSkillListingAttachments(ctx, skills, true, config),
    ).toMatchObject([{ names: ['b'], isInitial: false }]);
    const child = { ...ctx, agentId: 'child' };
    expect(
      await getSkillListingAttachments(child, skills, false, config),
    ).toMatchObject([{ names: ['a', 'b'], isInitial: true }]);
    resetSkillListingState(child);
    expect(
      await getSkillListingAttachments(ctx, skills, false, config),
    ).toEqual([]);
    expect(
      await getSkillListingAttachments(child, skills, false, config),
    ).toMatchObject([{ names: ['a', 'b'], isInitial: true }]);
  });

  it('preserves empty and removal resends outside interactive discovery', async () => {
    const ctx = createAttachmentContext('/workspace');
    expect(await getSkillListingAttachments(ctx, [], true)).toMatchObject([
      {
        content: 'No skills are currently available.',
        names: [],
        isInitial: true,
      },
    ]);
    await getSkillListingAttachments(ctx, [SKILL]);
    expect(await getSkillListingAttachments(ctx, [])).toMatchObject([
      {
        content: 'No skills are currently available.',
        names: [],
        isInitial: true,
      },
    ]);
    expect(await getSkillListingAttachments(ctx, [SKILL])).toMatchObject([
      { names: [SKILL.name], isInitial: true },
    ]);
  });

  it.each([true, false])(
    'skips the resend of a hot-reload that left the listing unchanged (preserveNames=%s)',
    async (preserveNames) => {
      const ctx = createAttachmentContext('/workspace');
      const skills = ['a', 'b'].map((name) => ({ ...SKILL, name }));

      expect(
        await getSkillListingAttachments(ctx, skills, true, { preserveNames }),
      ).toMatchObject([{ names: ['a', 'b'], isInitial: true }]);

      // Skill-change events clear the sent names unconditionally; a reload
      // that left the listing untouched must not inject it a second time.
      ctx.sentSkillNames.clear();
      expect(
        await getSkillListingAttachments(ctx, skills, false, { preserveNames }),
      ).toEqual([]);

      // A new skill, and a changed description, still resend.
      ctx.sentSkillNames.clear();
      expect(
        await getSkillListingAttachments(
          ctx,
          [...skills, { ...SKILL, name: 'c' }],
          false,
          { preserveNames },
        ),
      ).toMatchObject([{ names: ['a', 'b', 'c'], isInitial: true }]);

      ctx.sentSkillNames.clear();
      expect(
        await getSkillListingAttachments(
          ctx,
          [...skills, { ...SKILL, name: 'c', description: 'Changed' }],
          false,
          { preserveNames },
        ),
      ).toMatchObject([{ names: ['a', 'b', 'c'], isInitial: true }]);
    },
  );

  it('resends an identical listing after an explicit reset', async () => {
    const ctx = createAttachmentContext('/workspace');
    const skills = ['a', 'b'].map((name) => ({ ...SKILL, name }));

    await getSkillListingAttachments(ctx, skills, true);
    ctx.sentSkillNames.clear();
    expect(await getSkillListingAttachments(ctx, skills, false)).toEqual([]);

    // Compaction discards the prefix holding the listing, so the full list
    // must be re-emitted even though its content is unchanged.
    resetSkillListingState(ctx);
    expect(await getSkillListingAttachments(ctx, skills, false)).toMatchObject([
      { names: ['a', 'b'], isInitial: true },
    ]);
  });

  it.each([
    { columnsPerToken: 4 as const, budgetFraction: 0.01, descriptions: 5 },
    { columnsPerToken: 3 as const, budgetFraction: 0.01, descriptions: 4 },
    { columnsPerToken: 3 as const, budgetFraction: 0.02, descriptions: 5 },
  ])(
    'uses $columnsPerToken columns/token and the configured fraction $budgetFraction',
    async ({ columnsPerToken, budgetFraction, descriptions }) => {
      const skills = ['a', 'b', 'c', 'd', 'e'].map((name) => ({
        ...SKILL,
        name,
        description: 'x'.repeat(1490),
      }));
      const [listing] = await getSkillListingAttachments(
        createAttachmentContext('/workspace'),
        skills,
        true,
        {
          preserveNames: true,
          contextWindowTokens: 200_000,
          columnsPerToken,
          budgetFraction,
          maxDescChars: 1536,
        },
      );
      expect(listing.names).toEqual(skills.map((skill) => skill.name));
      expect(listing.content).toBe(
        skills
          .map((skill, index) =>
            index < descriptions
              ? `- ${skill.name}: ${skill.description}`
              : `- ${skill.name}`,
          )
          .join('\n'),
      );
    },
  );

  it('preserves names within the model budget outside interactive discovery', async () => {
    const [listing] = await getSkillListingAttachments(
      createAttachmentContext('/workspace'),
      [{ ...SKILL, name: 'a', description: 'x'.repeat(10) }],
      true,
      { contextWindowTokens: 4, columnsPerToken: 3, budgetFraction: 1 },
    );
    expect(listing.content).toBe('- a');
  });

  it('allocates descriptions by usage score while preserving listing order and every name', async () => {
    const skills = ['a', 'b', 'c'].map((name) => ({
      ...SKILL,
      name,
      description: '0123456789',
    }));
    const [listing] = await getSkillListingAttachments(
      createAttachmentContext('/workspace'),
      skills,
      true,
      {
        preserveNames: true,
        contextWindowTokens: 7,
        budgetFraction: 1,
        getUsageScore: (name) => (name === 'c' ? 10 : 0),
      },
    );
    expect(listing.content).toBe('- a\n- b\n- c: 0123456789');
    expect(listing.names).toEqual(['a', 'b', 'c']);
  });

  it('keeps bundled descriptions and name-only entries even when names exceed the soft budget', async () => {
    const [listing] = await getSkillListingAttachments(
      createAttachmentContext('/workspace'),
      [
        { ...SKILL, name: 'bundled', isBuiltin: true },
        { ...SKILL, name: 'name-only' },
        { ...SKILL, name: 'ordinary' },
      ],
      true,
      {
        preserveNames: true,
        contextWindowTokens: 1,
        budgetFraction: 0.01,
        visibilityOverrides: { 'name-only': 'name-only' },
      },
    );
    expect(listing.content).toBe(
      '- bundled: Inspect a repository\n- name-only\n- ordinary',
    );
  });

  it.each([true, false])(
    'uses unified defaults with preserveNames=%s',
    async (preserveNames) => {
      const skill = { ...SKILL, description: 'x'.repeat(1800) };
      const [full] = await getSkillListingAttachments(
        createAttachmentContext('/workspace'),
        [skill],
        true,
        { preserveNames },
      );
      expect(full.content).toBe(`- inspect: ${'x'.repeat(299)}…`);
      const [budgeted] = await getSkillListingAttachments(
        createAttachmentContext('/workspace'),
        [skill],
        true,
        { preserveNames: true, contextWindowTokens: 100 },
      );
      expect(budgeted.content).toBe('- inspect');
    },
  );

  it('uses the minimum soft budget for explicit zero in every entry point', async () => {
    const [interactive] = await getSkillListingAttachments(
      createAttachmentContext('/workspace'),
      [SKILL],
      true,
      { preserveNames: true, budgetFraction: 0 },
    );
    expect(interactive.content).toBe('- inspect');
    const [legacy] = await getSkillListingAttachments(
      createAttachmentContext('/workspace'),
      [SKILL],
      true,
      { budgetFraction: 0 },
    );
    expect(legacy.content).toBe('- inspect');
  });

  it.each([
    {
      name: 'Chinese names and descriptions',
      skills: [
        { ...SKILL, name: '中文', description: '描述' },
        { ...SKILL, name: 'b', description: 'x' },
      ],
      expected: '- 中文: 描述\n- b',
    },
    {
      name: 'emoji sequences and combining marks',
      skills: [
        { ...SKILL, name: 'a', description: '👨‍👩‍👧‍👦' },
        { ...SKILL, name: 'b', description: 'e\u0301' },
      ],
      expected: '- a: 👨‍👩‍👧‍👦\n- b: e\u0301',
    },
  ])(
    'budgets $name by display width, with one column per listing newline',
    async ({ skills, expected }) => {
      // Widths verified against native Bun.stringWidth({ ambiguousIsNarrow: true }).
      // Chinese is two columns per character; the joined family emoji is two,
      // and the accented e is one. UTF-16 length would select different entries.
      const [listing] = await getSkillListingAttachments(
        createAttachmentContext('/workspace'),
        skills,
        true,
        { preserveNames: true, contextWindowTokens: 4, budgetFraction: 1 },
      );
      expect(listing.content).toBe(expected);
    },
  );

  it('does not resend a restored skill listing on the first turn after resume', async () => {
    const ctx = createAttachmentContext('/workspace');
    ctx.sentSkillNames.set('main', new Set([SKILL.name]));

    const attachments = await getSkillListingAttachments(ctx, [SKILL], true);

    expect(attachments).toEqual([]);
  });

  it('sends the full skill listing for a genuinely new session', async () => {
    const ctx = createAttachmentContext('/workspace');

    const attachments = await getSkillListingAttachments(ctx, [SKILL], true);

    expect(attachments).toMatchObject([
      {
        type: 'skill_listing',
        names: [SKILL.name],
        isInitial: true,
      },
    ]);
  });
});
