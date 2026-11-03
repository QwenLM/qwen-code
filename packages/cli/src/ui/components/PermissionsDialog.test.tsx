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
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { withProviders } from '../../test-utils/render.js';
import { PermissionsDialog } from './PermissionsDialog.js';

const BADGE = '(invalid: not applied)';

function stubConfig(
  rules: RuleWithSource[],
  removePersistentRule = vi.fn(),
): Config {
  // One manager for the whole render: the dialog reads it during render, so a
  // fresh object per call would churn the effect that pulls the rules in.
  const manager = {
    listRules: () => rules,
    removePersistentRule,
  };
  return {
    getPermissionManager: () => manager,
    getWorkspaceContext: () => ({
      getDirectories: () => [],
      getInitialDirectories: () => [],
    }),
  } as unknown as Config;
}

async function renderRuleList(
  rules: RuleWithSource[],
  settings?: LoadedSettings,
) {
  const removePersistentRule = vi.fn();
  const instance = render(
    withProviders(<PermissionsDialog onExit={vi.fn()} />, {
      config: stubConfig(rules, removePersistentRule),
      settings,
    }),
  );
  // The rules arrive through an effect, so the first frame is still empty.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    ...instance,
    removePersistentRule,
  };
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

  it('flattens carriage returns in a malformed row label', async () => {
    const raw = 'Bash(rm -rf /\rBash(git *)';
    const { lastFrame } = await renderRuleList([invalidRule(raw)]);

    expect(lastFrame()).toContain(BADGE);
    expect(lastFrame()).toContain('Bash(rm -rf / Bash(git *)');
    expect(lastFrame()).not.toContain('\r');
  });

  it('sanitizes the delete-confirm rule but deletes the raw value', async () => {
    const raw = 'Bash(docker *\rBash(git *)';
    const { lastFrame, stdin, removePersistentRule } = await renderRuleList([
      invalidRule(raw),
    ]);

    await act(async () => {
      stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      stdin.write('\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(lastFrame()).toContain('Delete allow rule?');
    expect(lastFrame()).toContain('Bash(docker *');
    expect(lastFrame()).not.toContain('\r');

    await act(async () => {
      stdin.write('\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(removePersistentRule).toHaveBeenCalledWith(raw, 'allow');
  });

  it('deletes a settings rule whose stored spelling has surrounding whitespace', async () => {
    const raw = 'Bash(docker *';
    const settings = new LoadedSettings(
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      {
        path: '',
        settings: { permissions: { allow: [`  ${raw}  `] } },
        originalSettings: {},
      },
      { path: '', settings: {}, originalSettings: {} },
      true,
      new Set(),
    );
    const { stdin, removePersistentRule } = await renderRuleList(
      [invalidRule(raw)],
      settings,
    );
    const setValue = vi
      .spyOn(settings, 'setValue')
      .mockImplementation(() => {});

    await act(async () => {
      stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      stdin.write('\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      stdin.write('\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(removePersistentRule).toHaveBeenCalledWith(raw, 'allow');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'permissions.allow',
      [],
    );
  });

  it('does not throw when settings contain non-string entries', async () => {
    const raw = 'Bash(docker *';
    const settings = new LoadedSettings(
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      {
        path: '',
        settings: {
          permissions: { allow: [`  ${raw}  `, null as unknown as string] },
        },
        originalSettings: {},
      },
      { path: '', settings: {}, originalSettings: {} },
      true,
      new Set(),
    );
    const { stdin, removePersistentRule } = await renderRuleList(
      [invalidRule(raw)],
      settings,
    );
    const setValue = vi
      .spyOn(settings, 'setValue')
      .mockImplementation(() => {});

    await act(async () => {
      stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      stdin.write('\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      stdin.write('\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(removePersistentRule).toHaveBeenCalledWith(raw, 'allow');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'permissions.allow',
      [],
    );
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

  it('sanitizes bidi and carriage returns in a valid row label', async () => {
    const rlo = String.fromCharCode(0x202e);
    const { lastFrame } = await renderRuleList([
      {
        rule: {
          raw: `Bash(git ${rlo}*\rstatus)`,
          toolName: 'run_shell_command',
        },
        type: 'allow',
        scope: 'user',
      },
    ]);

    expect(lastFrame()).toContain('Bash(git * status)');
    expect(lastFrame()).not.toContain(rlo);
    expect(lastFrame()).not.toContain('\r');
    expect(lastFrame()).not.toContain(BADGE);
  });
});
