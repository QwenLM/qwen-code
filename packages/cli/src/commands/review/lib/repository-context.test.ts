/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
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
    for (const separator of ['\n', '\u0085', '\u2028', '\u2029']) {
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
        domains: Array.from({ length: 129 }, (_, index) => `d${index}`),
      }),
    ).toThrow('domains is invalid');
  });

  it('rejects unsafe paths and roles that cannot join the initial roster', () => {
    for (const path of [
      '../secret',
      '/absolute',
      'C:',
      'C:relative',
      'C:/absolute',
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
