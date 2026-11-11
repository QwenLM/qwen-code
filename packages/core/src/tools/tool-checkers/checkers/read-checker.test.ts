/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from '../../../permissions/manager/decision/index.js';
import { readToolChecker } from './read-checker.js';
import { grepToolChecker, createGrepToolChecker } from './grep-checker.js';
import { globToolChecker, createGlobToolChecker } from './glob-checker.js';
import type { ToolPermissionReason } from '../checker-reasons.js';

const CWD = '/repo';

/** Network-path enforcement is Windows-only; run fn with process.platform stubbed. */
function withWindowsEnforcement<T>(fn: () => T): T {
  vi.stubGlobal(
    'process',
    Object.create(process, { platform: { get: () => 'win32' } }),
  );
  try {
    return fn();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('search root permission alignment', () => {
  it.each([
    String.raw`\\\\n|b'[^']*\\\\n`,
    String.raw`\\server\share`,
    '//server/share',
    '/net/server/content',
  ])(
    'treats Grep pattern %s as content rather than a path',
    async (pattern) => {
      for (const path of [undefined, `${CWD}/source.py`]) {
        const result = await grepToolChecker.check(
          { pattern, path },
          contextFor('Grep', emptyRules()),
        );
        expect(result.kind).toBe('allow');
      }
    },
  );

  it.each([
    '//server/share/**/*.ts',
    String.raw`\\server\share\**\*.ts`,
    '/net/server/**/*.ts',
  ])('still asks for network Glob pattern %s', async (pattern) => {
    await withWindowsEnforcement(async () => {
      for (const path of [undefined, CWD]) {
        const result = await globToolChecker.check(
          { pattern, path },
          contextFor('Glob', emptyRules()),
        );
        expect(result.kind).toBe('ask');
        expect(decisionPointOf(result)).toBe('fs_read.network_glob_pattern.ask');
      }
    });
  });

  it.each([
    ['Grep', grepToolChecker],
    ['Glob', globToolChecker],
  ] as const)(
    '%s checks only cwd by default and still checks explicit roots',
    async (name, checker) => {
      const rules: PermissionRules = {
        allow: {},
        ask: {},
        deny: { projectSettings: ['Read(//extra/**)'] },
      };
      const ctx = contextFor(name, rules, {
        additionalDirectories: ['/extra'],
      });
      expect((await checker.check({ pattern: '*.ts' }, ctx)).kind).toBe(
        'allow',
      );
      expect(
        (await checker.check({ pattern: '*.ts', path: '/extra' }, ctx)).kind,
      ).toBe('deny');
    },
  );

  it.each([
    ['Grep', createGrepToolChecker],
    ['Glob', createGlobToolChecker],
  ] as const)(
    '%s resolves relative input against live CWD while keeping rule roots stable',
    async (name, createChecker) => {
      let cwd = '/repo/src';
      const checker = createChecker(() => cwd);
      const rules: PermissionRules = {
        allow: {},
        ask: {},
        deny: { projectSettings: ['Read(/src/private/**)'] },
      };
      const input = { pattern: '*.ts', path: 'private' };
      expect((await checker.check(input, contextFor(name, rules))).kind).toBe(
        'deny',
      );
      expect(input.path).toBe('private');
      cwd = '/repo';
      expect((await checker.check(input, contextFor(name, rules))).kind).toBe(
        'allow',
      );
    },
  );

  it.each([grepToolChecker, globToolChecker])(
    'preserves network path spelling until permission validation',
    async (checker) => {
      await withWindowsEnforcement(async () => {
        for (const searchPath of [
          '//server/share',
          ' //server/share ',
          '\\\\server\\share',
        ]) {
          const result = await checker.check(
            { pattern: '*', path: searchPath },
            contextFor('Grep', emptyRules()),
          );
          expect(result.kind).toBe('ask');
        }
      });
    },
  );

  it.each([grepToolChecker, globToolChecker])(
    'does not rebase a network CWD into a local-looking path',
    async (checker) => {
      await withWindowsEnforcement(async () => {
        for (const searchPath of [undefined, 'child']) {
          const result = await checker.check(
            { pattern: '*', path: searchPath },
            contextFor('Grep', emptyRules(), { cwd: '//server/share' }),
          );
          expect(result.kind).toBe('ask');
        }
      });
    },
  );

  it('checks the actual root of an absolute Glob pattern', async () => {
    const rules: PermissionRules = {
      allow: {},
      ask: {},
      deny: { projectSettings: ['Read(//extra/**)'] },
    };
    expect(
      (
        await globToolChecker.check(
          { pattern: '/extra/**/*.ts', path: CWD },
          contextFor('Glob', rules),
        )
      ).kind,
    ).toBe('deny');
  });
});

function contextFor(
  toolName: string,
  rules: PermissionRules,
  overrides: Partial<ToolCheckContext<ToolPermissionReason>> = {},
): ToolCheckContext<ToolPermissionReason> {
  return {
    mode: PermissionModes.Default,
    rules,
    cwd: CWD,
    additionalDirectories: [],
    rulesForTool: rulesForToolName(rules, toolName),
    toolUseId: 'tu-1',
    ...overrides,
  };
}

function emptyRules(): PermissionRules {
  return { allow: {}, ask: {}, deny: {} };
}

function decisionPointOf(result: {
  kind: string;
  extra?: { decisionPoint?: string };
  reason?: { decisionPoint?: string };
}): string | undefined {
  return result.extra?.decisionPoint ?? result.reason?.decisionPoint;
}

describe('readToolChecker', () => {
  it('allows a no-path search when no root is denied', async () => {
    const result = await readToolChecker.check(
      { pattern: 'TODO' },
      contextFor('Grep', emptyRules(), {
        additionalDirectories: ['/extra'],
      }),
    );

    expect(result.kind).toBe('allow');
    expect(decisionPointOf(result)).toBe('fs_read.no_path.allow');
  });

  it('refuses a no-path search when a deny rule covers the working directory', async () => {
    // A single-slash pattern is rooted at its source's root; for project
    // settings that is the project itself, so `/**` covers the cwd.
    const rules: PermissionRules = {
      allow: {},
      ask: {},
      deny: { projectSettings: ['Read(/**)'] },
    };
    const result = await readToolChecker.check(
      { pattern: 'TODO' },
      contextFor('Grep', rules),
    );

    expect(result.kind).toBe('deny');
  });

  it('refuses a no-path search when a deny rule covers a trusted directory', async () => {
    // The execution layer fans the search out over the cwd plus every trusted
    // directory, so the check has to judge each root: one denied root refuses
    // the whole search.
    const rules: PermissionRules = {
      allow: {},
      ask: {},
      deny: { userSettings: ['Read(//extra/**)'] },
    };
    const result = await readToolChecker.check(
      { pattern: 'TODO' },
      contextFor('Grep', rules, { additionalDirectories: ['/extra'] }),
    );

    expect(result.kind).toBe('deny');
  });

  it('still checks the given path when one is present', async () => {
    const result = await readToolChecker.check(
      { file_path: '/etc/passwd' },
      contextFor('Read', emptyRules()),
    );

    // Outside every trusted root: the boundary ask stands.
    expect(result.kind).toBe('ask');
  });
});
