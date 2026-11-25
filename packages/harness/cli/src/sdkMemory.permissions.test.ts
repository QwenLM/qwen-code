/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PermissionModes,
  permissionRuleValueToString,
  rulesForToolName,
  type ToolCheckContext,
} from '@qwen-code/core';
import { buildSdkMemoryPermissionUpdates } from './sdkMemory.js';
import {
  checkWritePermissionForPath,
  matchingRuleForInput,
} from '../../core/src/tools/filesystem-permissions/filesystem.js';
import { withSessionModeForTest } from '../../core/src/test-utils/config.js';
import type { ToolPermissionReason } from '../../core/src/tools/tool-checkers/checker-reasons.js';

vi.hoisted(() => vi.resetModules());
vi.mock('../../core/src/utils/platform.js', () => ({
  getPlatform: () => 'windows',
}));

const root = 'C:\\Users\\tester\\gen-root';
const target = root + '\\MEMORY.md';
const cwd = 'C:\\Users\\tester\\gen-work';

function contextForRoot(
  access: 'read' | 'read-write',
  rootPath = root,
): ToolCheckContext<ToolPermissionReason> {
  const [update] = buildSdkMemoryPermissionUpdates([
    { id: 'tenant', path: rootPath, access },
  ]);
  if (update?.type !== 'addRules') throw new Error('Expected memory root rules');
  const rules = {
    allow: { session: update.rules.map(permissionRuleValueToString) },
    deny: {},
    ask: {},
  };
  return {
    mode: PermissionModes.DontAsk,
    rules,
    cwd,
    additionalDirectories: [root],
    rulesForTool: rulesForToolName(rules, 'Write'),
    toolUseId: 'memory-write',
  };
}

const writeChecker = withSessionModeForTest({
  check(input, context) {
    return checkWritePermissionForPath(
      input['file_path'] as string,
      context,
      context.cwd,
    );
  },
}, 'Write');

describe('SDK memory Windows permissions', () => {
  it.each([root, root + '\\', 'c:/Users/tester/gen-root'])(
    'allows writes under the read-write root %s in dontAsk mode',
    async (rootPath) => {
      const result = await writeChecker.check(
        { file_path: target },
        contextForRoot('read-write', rootPath),
      );
      expect(result).toMatchObject({
        kind: 'allow',
        extra: { decisionPoint: 'fs_write.rule.allow' },
      });
    },
  );

  it('does not grant writes outside the registered root', async () => {
    const result = await writeChecker.check(
      { file_path: 'C:\\Users\\tester\\gen-root-other\\MEMORY.md' },
      contextForRoot('read-write'),
    );
    expect(result).toMatchObject({
      kind: 'deny',
      extra: { decisionPoint: 'mode.dont_ask.deny' },
    });
  });

  it('grants reads but does not grant writes for a read-only root', async () => {
    const context = contextForRoot('read');
    expect(
      matchingRuleForInput(target, context, 'read', 'allow', cwd),
    ).not.toBeNull();
    expect(
      matchingRuleForInput(target, context, 'edit', 'allow', cwd),
    ).toBeNull();
    expect(
      await writeChecker.check({ file_path: target }, context),
    ).toMatchObject({ kind: 'deny' });
  });
});
