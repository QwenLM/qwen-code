/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from '../../../permissions/manager/decision/index.js';
import { writeToolChecker } from './write-checker.js';
import type { ToolPermissionReason } from '../checker-reasons.js';

const CWD = '/repo';

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

describe('writeToolChecker', () => {
  it('fail-closes a write with no path to validate', async () => {
    const result = await writeToolChecker.check(
      {},
      contextFor('Write', emptyRules()),
    );

    expect(result.kind).toBe('deny');
    expect(decisionPointOf(result)).toBe('fs_write.no_path.deny');
  });
});
