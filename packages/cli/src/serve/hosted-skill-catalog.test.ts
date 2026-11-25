/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  HostedSkillCatalog,
  parseHostedSkills,
  readHostedSkills,
} from './hosted-skill-catalog.js';

const skill = {
  name: 'code-review',
  description: 'Review <code> changes.',
  body: 'Read references/review.md before reviewing.',
  base_directory: '.qwen/skills/code-review',
};

it.each([
  ['/code-review inspect this', ['code-review']],
  ['  /code-review\n/code-review inspect this', ['code-review']],
  ['/code-reviewer inspect this', []],
  ['Explain /code-review', []],
  ['/unknown /code-review', []],
  ['/code-review/path', []],
])(
  'recognizes only exact leading published invocations in %s',
  (prompt, names) => {
    expect(new HostedSkillCatalog([skill]).invocations(prompt)).toEqual(names);
  },
);

it('advertises only published descriptions and loads a fixed Workspace-relative body', () => {
  const source = [{ ...skill }];
  const catalog = new HostedSkillCatalog(source);
  source[0].body = 'Changed after publication.';
  expect(catalog.instructions()).toContain('Review &lt;code&gt; changes.');
  expect(catalog.instructions()).not.toContain(skill.body);
  expect(catalog.declaration()).toMatchObject({
    name: 'skill',
    parametersJsonSchema: {
      required: ['skill'],
      additionalProperties: false,
      properties: { skill: { enum: ['code-review'] } },
    },
  });
  const response = catalog.response({ skill: 'code-review' });
  expect(response).toContain(skill.base_directory);
  expect(response).toContain(skill.body);
  expect(catalog.response({ skill: 'code-review' })).toBe(response);
  expect(catalog.response({ skill: 'code-review' })).not.toContain(
    source[0].body,
  );
  expect(new HostedSkillCatalog([]).declaration()).toBeUndefined();
  expect(new HostedSkillCatalog([]).instructions()).toBeUndefined();
});

it.each([
  { ...skill, hooks: {} },
  { ...skill, allowedTools: ['Bash'] },
  { ...skill, model: 'fast' },
  { ...skill, paths: ['src/**'] },
  { ...skill, name: '<injected>' },
  { ...skill, name: 'a'.repeat(129) },
  { ...skill, description: '界'.repeat(1366) },
  { ...skill, body: '界'.repeat(174763) },
  { ...skill, body: '' },
  { ...skill, body: '\ud800' },
  { ...skill, description: '\udfff' },
  { ...skill, base_directory: '/tmp/private' },
  { ...skill, base_directory: '../private' },
  { ...skill, base_directory: 'a/../b' },
  { ...skill, base_directory: 'a//b' },
  { ...skill, base_directory: './a' },
  { ...skill, base_directory: 'a/.' },
  { ...skill, base_directory: 'a\\b' },
  { ...skill, base_directory: 'C:private' },
  { ...skill, base_directory: 'a\nb' },
  { ...skill, base_directory: 'a:b' },
  { ...skill, base_directory: 'a\u0085b' },
])('refuses unsupported or invalid published fields: %j', (entry) => {
  expect(() => parseHostedSkills([entry])).toThrow();
});

it('refuses duplicate names, item and total byte limits, and unsupported invocation options', () => {
  expect(() => parseHostedSkills([skill, skill])).toThrow();
  expect(() =>
    parseHostedSkills(
      Array.from({ length: 257 }, (_, i) => ({ ...skill, name: `s${i}` })),
    ),
  ).toThrow();
  expect(() =>
    parseHostedSkills([
      ...Array.from({ length: 5 }, (_, i) => ({
        ...skill,
        name: `large-${i}`,
        body: 'x'.repeat(512 * 1024),
      })),
    ]),
  ).toThrow();
  const catalog = new HostedSkillCatalog([skill]);
  for (const args of [
    {},
    [],
    { skill: 'unknown' },
    { skill: 'code-review', args: '--post' },
    { skill: 'code-review', model: 'fast' },
  ]) {
    expect(catalog.validationError(args)).toBeTypeOf('string');
    expect(() => catalog.response(args)).toThrow();
  }
  expect(
    new HostedSkillCatalog([{ ...skill, base_directory: undefined }]).response({
      skill: skill.name,
    }),
  ).toContain('Session working directory: .\n');
});

it('verifies the original durable bytes, kind, digest and UTF-8 before loading', async () => {
  const bytes = Buffer.from(JSON.stringify([skill]));
  const ref = {
    resourceId: 'published-skills',
    kind: 'managed-agent-skills',
    schemaVersion: 1,
    byteLength: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
  const read = vi.fn(async () => bytes);
  expect(await readHostedSkills(ref, { read })).toEqual([skill]);
  await expect(
    readHostedSkills({ ...ref, kind: 'managed-agent-instructions' }, { read }),
  ).rejects.toThrow();
  await expect(
    readHostedSkills({ ...ref, byteLength: ref.byteLength + 1 }, { read }),
  ).rejects.toThrow();
  await expect(
    readHostedSkills({ ...ref, digest: '0'.repeat(64) }, { read }),
  ).rejects.toThrow();
  const invalid = Buffer.from([0xff]);
  await expect(
    readHostedSkills(
      {
        ...ref,
        byteLength: invalid.length,
        digest: createHash('sha256').update(invalid).digest('hex'),
      },
      { read: async () => invalid },
    ),
  ).rejects.toThrow();
  expect(await readHostedSkills(undefined, { read })).toEqual([]);
});

it('keeps manual-only Skills user-invocable and user-hidden Skills model-invocable', () => {
  const catalog = new HostedSkillCatalog([
    { ...skill, name: 'manual', model_invocable: false },
    { ...skill, name: 'model-only', user_invocable: false },
  ]);
  expect(catalog.instructions()).not.toContain('<name>\nmanual\n</name>');
  expect(catalog.declaration()?.parametersJsonSchema).toMatchObject({
    properties: { skill: { enum: ['model-only'] } },
  });
  expect(catalog.invocations('/manual inspect')).toEqual(['manual']);
  expect(catalog.invocations('/model-only inspect')).toEqual([]);
  expect(catalog.validationError({ skill: 'manual' }, 'model')).toContain(
    'only',
  );
  expect(catalog.validationError({ skill: 'manual' }, 'user')).toBeUndefined();
  expect(catalog.validationError({ skill: 'model-only' }, 'user')).toContain(
    'not user-invocable',
  );
  expect(
    catalog.validationError({ skill: 'model-only' }, 'model'),
  ).toBeUndefined();
  expect(catalog.response({ skill: 'manual' })).toContain(skill.body);
});

it('accepts the complete 42-Skill catalog with a bounded large body', () => {
  const skills = Array.from({ length: 42 }, (_, i) => ({
    ...skill,
    name: `s${i}`,
    body: i === 0 ? 'x'.repeat(404465) : 'instruction',
  }));
  expect(parseHostedSkills(skills)).toHaveLength(42);
  expect(new HostedSkillCatalog(skills).response({ skill: 's0' })).toContain(
    skills[0]!.body,
  );
});
