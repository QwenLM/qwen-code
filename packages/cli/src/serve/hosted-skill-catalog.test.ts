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
  { ...skill, body: '界'.repeat(10923) },
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
      Array.from({ length: 17 }, (_, i) => ({ ...skill, name: `s${i}` })),
    ),
  ).toThrow();
  expect(() =>
    parseHostedSkills([
      { ...skill, name: 'a', body: 'x'.repeat(32768) },
      { ...skill, name: 'b', body: 'x'.repeat(32768) },
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
