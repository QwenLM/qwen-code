/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { RuleWithSource } from '@qwen-code/qwen-code-core/permissions/types.js';
import { render } from 'ink-testing-library';
import { withProviders } from '../../test-utils/render.js';
import { PermissionsDialog } from './PermissionsDialog.js';

const BADGE = '(invalid: not applied)';

function stubConfig(rules: RuleWithSource[]): Config {
  // One manager for the whole render: the dialog reads it during render, so a
  // fresh object per call would churn the effect that pulls the rules in.
  const manager = { listRules: () => rules };
  return {
    getPermissionManager: () => manager,
    getWorkspaceContext: () => ({
      getDirectories: () => [],
      getInitialDirectories: () => [],
    }),
  } as unknown as Config;
}

async function renderRuleList(rules: RuleWithSource[]) {
  const instance = render(
    withProviders(<PermissionsDialog onExit={vi.fn()} />, {
      config: stubConfig(rules),
    }),
  );
  // The rules arrive through an effect, so the first frame is still empty.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return instance;
}

const invalidRule = (raw: string): RuleWithSource => ({
  rule: { raw, toolName: 'run_shell_command', invalid: true },
  type: 'allow',
  scope: 'user',
});

describe('PermissionsDialog malformed rule rows', () => {
  it('marks a malformed rule as not applied', async () => {
    const { lastFrame } = await renderRuleList([invalidRule('Bash(docker *')]);

    expect(lastFrame()).toContain(BADGE);
    expect(lastFrame()).toContain('Bash(docker *');
  });

  // The row is clipped from the tail to the terminal width, so a badge that
  // trails the rule is the first thing a long rule loses. This frame at 100
  // columns is what pins that: move the badge back to the tail and the marker
  // disappears here while every other test stays green.
  it('keeps the badge on a rule too long for the row', async () => {
    const tooLongForOneRow = `Bash(${'x'.repeat(300)}`;
    const { lastFrame } = await renderRuleList([invalidRule(tooLongForOneRow)]);

    expect(lastFrame()).toContain(BADGE);
  });

  it('leaves a valid rule unmarked', async () => {
    const { lastFrame } = await renderRuleList([
      {
        rule: { raw: 'Bash(git *)', toolName: 'run_shell_command' },
        type: 'allow',
        scope: 'user',
      },
    ]);

    expect(lastFrame()).toContain('Bash(git *)');
    expect(lastFrame()).not.toContain(BADGE);
  });
});
