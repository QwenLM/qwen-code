/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatform } from '../../utils/platform.js';
import { directoryPermissionPattern } from './pathRules.js';
import {
  checkReadPermissionForPath,
  checkWritePermissionForPath,
  matchingRuleForInput,
} from './filesystem.js';
import {
  createReadRuleSuggestion,
  type PathPermissionContext,
} from '../tool-checkers/checker-reasons.js';

vi.hoisted(() => vi.resetModules());
vi.mock('../../utils/platform.js', () => ({ getPlatform: vi.fn() }));

function contextForDirectory(dirPath: string): PathPermissionContext {
  const pattern = directoryPermissionPattern(dirPath);
  return {
    rules: {
      allow: { session: ['Read(' + pattern + ')', 'Edit(' + pattern + ')'] },
      deny: {},
      ask: {},
    },
    additionalDirectories: [],
  };
}

beforeEach(() => vi.mocked(getPlatform).mockReturnValue('linux'));
afterEach(() => vi.unstubAllGlobals());

describe('directory permission rules', () => {
  it.each(['/tmp/memory', '/tmp/memory/'])(
    'grants only the POSIX directory %s and its descendants',
    (root) => {
      const context = contextForDirectory(root);
      expect(
        matchingRuleForInput('/tmp/memory/MEMORY.md', context, 'edit', 'allow', '/repo'),
      ).not.toBeNull();
      expect(
        matchingRuleForInput('/tmp/memory/subdir/facts.md', context, 'read', 'allow', '/repo'),
      ).not.toBeNull();
      expect(
        matchingRuleForInput('/tmp/memory-other/MEMORY.md', context, 'edit', 'allow', '/repo'),
      ).toBeNull();
    },
  );

  it.each([
    'C:\\Users\\tester\\memory',
    'c:\\Users\\tester\\memory\\',
    'C:/Users/tester/memory',
    '/c/Users/tester/memory',
  ])('uses the Windows matcher path representation for %s', (root) => {
    vi.mocked(getPlatform).mockReturnValue('windows');
    const context = contextForDirectory(root);
    expect(directoryPermissionPattern(root)).toBe('//c/Users/tester/memory/**');
    expect(
      matchingRuleForInput(
        'C:\\Users\\tester\\memory\\MEMORY.md',
        context,
        'edit',
        'allow',
        'C:\\project',
      ),
    ).not.toBeNull();
    expect(
      matchingRuleForInput(
        'C:\\Users\\tester\\other\\MEMORY.md',
        context,
        'edit',
        'allow',
        'C:\\project',
      ),
    ).toBeNull();
  });

  it('preserves relative directory rule semantics', () => {
    expect(directoryPermissionPattern('docs')).toBe('docs/**');
    expect(directoryPermissionPattern('')).toBe('/**');
  });

  it('keeps the filesystem root out of interactive read suggestions', () => {
    expect(createReadRuleSuggestion('/')).toBeUndefined();
  });

  it('uses the shared path rules for native Windows read suggestions', () => {
    vi.mocked(getPlatform).mockReturnValue('windows');
    const suggestion = createReadRuleSuggestion('C:\\Users\\tester\\memory');
    expect(suggestion).toMatchObject({
      type: 'addRules',
      rules: [{ toolName: 'Read', ruleContent: '//c/Users/tester/memory/**' }],
    });
  });

  it('preserves network paths and their mandatory confirmation', () => {
    vi.mocked(getPlatform).mockReturnValue('windows');
    vi.stubGlobal(
      'process',
      Object.create(process, { platform: { get: () => 'win32' } }),
    );
    const root = '\\\\server\\share\\memory';
    const context = contextForDirectory(root);
    expect(directoryPermissionPattern(root)).toBe('///server/share/memory/**');
    for (const check of [checkReadPermissionForPath, checkWritePermissionForPath]) {
      const result = check(root + '\\MEMORY.md', context, 'C:\\project');
      expect(result.kind).toBe('ask');
      if (result.kind === 'ask') {
        expect(result.reason.decisionPoint).toContain('network_path.ask');
        expect(result.suggestions ?? []).toEqual([]);
      }
    }
  });
});
