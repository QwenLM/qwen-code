/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { REPOSITORY_CONTEXT_ROLES } from './agent-briefs.js';
import {
  repositoryContextOf,
  validateRepositoryContext,
} from './repository-context.js';

const valid = {
  version: 1,
  provider: 'example-provider',
  label: 'Example project',
  domains: ['compiler', 'runtime'],
  relatedPaths: ['src/compiler.ts', 'src/runtime.ts'],
  recommendedTests: ['test:compiler', 'test:runtime'],
  requiredConfigurations: ['debug', 'linux-x64'],
  requiredAgents: ['1a', 'test-matrix'],
  unverifiedDimensions: ['Alternate runtime was not exercised'],
  verificationNotes: ['Use the repository native test runner'],
};

describe('repository context validation', () => {
  it('accepts the strict versioned generic schema', () => {
    expect(validateRepositoryContext(valid)).toEqual(valid);
    expect(repositoryContextOf({ repositoryContext: valid })).toEqual(valid);
    expect(repositoryContextOf({})).toBeNull();
  });

  it('fails closed on a present-but-null repositoryContext', () => {
    // repo-context writes literal `null` artifact files, so a corrupted plan
    // can carry the shape; a falsy-check regression would degrade open in
    // every consumer at once instead of failing closed.
    expect(() => repositoryContextOf({ repositoryContext: null })).toThrow(
      'repositoryContext must be an object',
    );
  });

  it('rejects unknown or missing fields and versions', () => {
    expect(() => validateRepositoryContext({ ...valid, version: 2 })).toThrow(
      'unsupported repositoryContext version',
    );
    expect(() => validateRepositoryContext({ ...valid, extra: true })).toThrow(
      'unknown or missing fields',
    );
    const { label: _label, ...withoutLabel } = valid;
    expect(() => validateRepositoryContext(withoutLabel)).toThrow(
      'unknown or missing fields',
    );
  });

  it('accepts bounded Unicode text and repository paths with spaces', () => {
    const context = {
      ...valid,
      label: '示例仓库',
      domains: ['编译器', '运行时'],
      relatedPaths: ['docs/设计说明.md', 'src/generated files/output.ts'],
      recommendedTests: ['运行核心测试'],
      requiredConfigurations: ['调试模式'],
      unverifiedDimensions: ['未验证备用运行时'],
      verificationNotes: ['使用仓库原生测试命令'],
    };
    expect(validateRepositoryContext(context)).toEqual(context);
  });

  it('requires bounded sorted unique safe tokens and text', () => {
    expect(() =>
      validateRepositoryContext({ ...valid, domains: ['runtime', 'compiler'] }),
    ).toThrow('sorted and unique');
    expect(() =>
      validateRepositoryContext({ ...valid, domains: ['runtime', 'runtime'] }),
    ).toThrow('sorted and unique');
    expect(() =>
      validateRepositoryContext({ ...valid, provider: '../provider' }),
    ).toThrow('provider is invalid');
    // isControlFree rejects all of 0x00-0x1F, 0x7F-0x9F, U+2028/2029, the
    // bidi directional formatting block, and zero-width hiding characters;
    // probing range ends plus interior points pins the range, not a
    // four-separator regex (under which `label: 'X\r## heading'`
    // validates and CR-overwrites the rendered heading).
    for (const separator of [
      '\u0000',
      '\u0005',
      '\r',
      '\u001f',
      '\n',
      '\u007f',
      '\u0085',
      '\u009f',
      '\u2028',
      '\u2029',
      '\u061c',
      '\u200b',
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202e',
      '\u2066',
      '\u2069',
      '\ufeff',
    ]) {
      expect(() =>
        validateRepositoryContext({
          ...valid,
          label: `bad${separator}heading`,
        }),
      ).toThrow('label is invalid');
    }
    expect(() =>
      validateRepositoryContext({
        ...valid,
        verificationNotes: ['x'.repeat(513)],
      }),
    ).toThrow('verificationNotes is invalid');
    expect(() =>
      validateRepositoryContext({
        ...valid,
        domains: Array.from({ length: 257 }, (_, index) => `d${index}`),
      }),
    ).toThrow('domains is invalid');
  });

  it('enforces sorted-and-unique on every array field', () => {
    // The manifest provider pre-sorts today; a future provider or a
    // hand-edited plan would not, so the wire check is pinned per field.
    const probes: Record<string, [unsorted: string[], duplicated: string[]]> = {
      recommendedTests: [
        ['test:runtime', 'test:compiler'],
        ['test:compiler', 'test:compiler'],
      ],
      requiredConfigurations: [
        ['linux-x64', 'debug'],
        ['debug', 'debug'],
      ],
      relatedPaths: [
        ['src/runtime.ts', 'src/compiler.ts'],
        ['src/compiler.ts', 'src/compiler.ts'],
      ],
      requiredAgents: [
        ['test-matrix', '1a'],
        ['test-matrix', 'test-matrix'],
      ],
      unverifiedDimensions: [
        ['later boundary', 'earlier boundary'],
        ['same boundary', 'same boundary'],
      ],
      verificationNotes: [
        ['second note', 'first note'],
        ['same note', 'same note'],
      ],
    };
    for (const [field, [unsorted, duplicated]] of Object.entries(probes)) {
      expect(() =>
        validateRepositoryContext({ ...valid, [field]: unsorted }),
      ).toThrow(`${field} must be sorted and unique`);
      expect(() =>
        validateRepositoryContext({ ...valid, [field]: duplicated }),
      ).toThrow(`${field} must be sorted and unique`);
    }
  });

  it('accepts every length bound exactly and rejects one past it', () => {
    // provider 64, label 120, token 160, path 512, note 512: the accept side
    // pins `>` (a `>=` regression would reject manifests at the documented
    // bounds) and the reject side pins the four remaining constants.
    const atBound = {
      ...valid,
      provider: 'p'.repeat(64),
      label: 'l'.repeat(120),
      domains: ['t'.repeat(160)],
      relatedPaths: ['a'.repeat(512)],
      recommendedTests: ['t'.repeat(160)],
      requiredConfigurations: ['t'.repeat(160)],
      unverifiedDimensions: ['n'.repeat(512)],
      verificationNotes: ['n'.repeat(512)],
    };
    expect(validateRepositoryContext(atBound)).toEqual(atBound);

    expect(() =>
      validateRepositoryContext({ ...valid, provider: 'p'.repeat(65) }),
    ).toThrow('provider is invalid');
    expect(() =>
      validateRepositoryContext({ ...valid, label: 'l'.repeat(121) }),
    ).toThrow('label is invalid');
    expect(() =>
      validateRepositoryContext({ ...valid, domains: ['t'.repeat(161)] }),
    ).toThrow('domains is invalid');
    expect(() =>
      validateRepositoryContext({
        ...valid,
        relatedPaths: ['a'.repeat(513)],
      }),
    ).toThrow('relatedPaths is invalid');
    expect(() =>
      validateRepositoryContext({
        ...valid,
        recommendedTests: ['t'.repeat(161)],
      }),
    ).toThrow('recommendedTests is invalid');
    expect(() =>
      validateRepositoryContext({
        ...valid,
        requiredConfigurations: ['t'.repeat(161)],
      }),
    ).toThrow('requiredConfigurations is invalid');
  });

  it('accepts the item-count bound exactly', () => {
    // The reject side pins 257 items; this accept pin sits exactly at
    // MAX_ARRAY_ITEMS, where a `>` → `>=` regression would reject the
    // maximum valid manifest at the documented bound.
    const atBound = {
      ...valid,
      domains: Array.from(
        { length: 256 },
        (_, index) => `d-${String(index).padStart(3, '0')}`,
      ),
    };
    expect(validateRepositoryContext(atBound)).toEqual(atBound);
  });

  it('accepts every role the allow-list admits', () => {
    // Hardcoded, not spread from the constant: the accept side must pin
    // all 15 roles, or dropping one from REPOSITORY_CONTEXT_ROLES ships
    // green (`satisfies readonly RoleId[]` still compiles, the type
    // narrows silently) and every consumer fails closed on a valid
    // manifest's required agent.
    const allRoles = [
      '1a',
      '1b',
      '1c',
      '2',
      '3a',
      '3b',
      '3c',
      '4',
      '5',
      '6a',
      '6b',
      '6c',
      '6d',
      'prose-exec',
      'test-matrix',
    ];
    expect([...REPOSITORY_CONTEXT_ROLES]).toEqual(allRoles);
    const context = { ...valid, requiredAgents: allRoles };
    expect(validateRepositoryContext(context)).toEqual(context);
  });

  it('rejects control characters inside array items', () => {
    for (const field of [
      'domains',
      'relatedPaths',
      'unverifiedDimensions',
      'verificationNotes',
    ] as const) {
      for (const separator of [
        '\u0000',
        '\u0005',
        '\r',
        '\u001f',
        '\n',
        '\u007f',
        '\u0085',
        '\u009f',
        '\u2028',
        '\u2029',
        '\u061c',
        '\u200b',
        '\u200e',
        '\u200f',
        '\u202a',
        '\u202e',
        '\u2066',
        '\u2069',
        '\ufeff',
      ]) {
        expect(() =>
          validateRepositoryContext({
            ...valid,
            [field]: [`bad${separator}item`],
          }),
        ).toThrow(`${field} is invalid`);
      }
    }
  });

  it('fails closed on non-string and empty values', () => {
    // The string-type and non-empty gates fail closed today; pin them, or
    // a future simplification ships green and `[object Object]` / `123` /
    // empty entries flow into every reviewer prompt and the posted body.
    expect(() => validateRepositoryContext({ ...valid, label: 123 })).toThrow(
      'label is invalid',
    );
    expect(() => validateRepositoryContext({ ...valid, label: '' })).toThrow(
      'label is invalid',
    );
    expect(() =>
      validateRepositoryContext({ ...valid, domains: [123] }),
    ).toThrow('domains is invalid');
    expect(() =>
      validateRepositoryContext({ ...valid, domains: [''] }),
    ).toThrow('domains is invalid');
    expect(() =>
      validateRepositoryContext({ ...valid, verificationNotes: [null] }),
    ).toThrow('verificationNotes is invalid');
  });

  it('rejects unsafe paths and roles that cannot join the initial roster', () => {
    for (const path of [
      '../secret',
      '/absolute',
      'C:',
      'C:relative',
      'C:/absolute',
      'd:relative',
      'a//b',
      'a/./b',
      'a\\b',
      'a/../b',
    ]) {
      expect(() =>
        validateRepositoryContext({ ...valid, relatedPaths: [path] }),
      ).toThrow();
    }
    for (const role of [
      'not-a-role',
      '7',
      'invariant-a',
      'verify',
      'reverse-audit',
    ]) {
      expect(() =>
        validateRepositoryContext({ ...valid, requiredAgents: [role] }),
      ).toThrow('unsupported role');
    }
  });
});
