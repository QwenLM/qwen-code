/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoClassifier,
  type EditableSettingSource,
  type SessionPermissionManager,
  type PermissionRule,
  type SettingsWriter,
} from '@qwen-code/core';
import { renderWithProviders as render } from '../../../test-utils/render.js';
import { waitFor } from '../../../test-utils/async.js';

const mocks = vi.hoisted(() => ({
  selectDestination: undefined as
    | undefined
    | ((value: EditableSettingSource) => void),
  selectRule: undefined as undefined | ((rule: PermissionRule) => void),
  deleteRule: undefined as undefined | (() => void),
  apply: vi.fn(),
}));
vi.mock('../shared/DescriptiveRadioButtonSelect.js', () => ({
  DescriptiveRadioButtonSelect: (props: {
    onSelect: typeof mocks.selectDestination;
  }) => {
    mocks.selectDestination = props.onSelect;
    return null;
  },
}));
vi.mock('../shared/BaseTabDialog.js', () => ({
  BaseTabDialog: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./PermissionRulesTab.js', () => ({
  PermissionRulesTab: (props: { onSelectRule: typeof mocks.selectRule }) => {
    mocks.selectRule = props.onSelectRule;
    return null;
  },
}));
vi.mock('./RuleDetails.js', () => ({
  RuleDetails: (props: { onDelete: typeof mocks.deleteRule }) => {
    mocks.deleteRule = props.onDelete;
    return null;
  },
}));
vi.mock('./usePermissionRules.js', () => ({
  usePermissionRules: () => ({
    rules: { allow: {}, deny: {}, ask: {} },
    directories: [],
    apply: mocks.apply,
  }),
}));

import { AddPermissionRules } from './AddPermissionRules.js';
import { PermissionRuleList } from './PermissionRuleList.js';

// 保护不变量：保存失败不更新运行规则或宣告成功，原输入可在失败解除后重试。
describe('permission persistence failure boundaries', () => {
  let fail: boolean;
  let data: { permissions: { allow: string[] } };
  let writer: SettingsWriter;
  beforeEach(() => {
    vi.clearAllMocks();
    fail = true;
    data = { permissions: { allow: ['Read(./existing.txt)'] } };
    writer = {
      getSettingsForSource: () => data,
      mutateSettingsForSource: (_source, mutate) => {
        if (fail) return { error: new Error('injected save failure') };
        mutate(data);
        return {};
      },
    };
  });

  it.each(['userSettings', 'projectSettings', 'localSettings'] as const)(
    'keeps an add pending after failure in %s and applies it only after retry',
    async (destination) => {
      const onAddRules = vi.fn();
      const view = await render(
        <AddPermissionRules
          onAddRules={onAddRules}
          onCancel={vi.fn()}
          ruleValues={[{ toolName: 'Read', ruleContent: './new.txt' }]}
          ruleBehavior="allow"
          applyUpdates={mocks.apply}
          rulesAfterApply={() => ({ allow: {}, deny: {}, ask: {} })}
          settingsWriter={writer}
        />,
      );
      await act(async () => mocks.selectDestination!(destination));
      expect(mocks.apply).not.toHaveBeenCalled();
      expect(onAddRules).not.toHaveBeenCalled();
      expect(data.permissions.allow).toEqual(['Read(./existing.txt)']);
      await waitFor(() =>
        expect(view.lastFrame()).toContain('Failed to save permission rules'),
      );
      fail = false;
      await act(async () => mocks.selectDestination!(destination));
      expect(data.permissions.allow).toContain('Read(./new.txt)');
      expect(mocks.apply).toHaveBeenCalledWith(
        expect.objectContaining({ destination, type: 'addRules' }),
      );
      expect(onAddRules).toHaveBeenCalled();
      view.unmount();
    },
  );

  it.each(['userSettings', 'projectSettings', 'localSettings'] as const)(
    'keeps a delete pending after failure in %s and removes it only after retry',
    async (source) => {
      const onExit = vi.fn();
      const view = await render(
        <PermissionRuleList
          onExit={onExit}
          permission={{} as SessionPermissionManager}
          autoMode={new AutoClassifier()}
          initialTab="allow"
          settingsWriter={writer}
        />,
      );
      await act(async () =>
        mocks.selectRule!({
          source,
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'Read', ruleContent: './existing.txt' },
        }),
      );
      await act(async () => mocks.deleteRule!());
      expect(mocks.apply).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
      expect(data.permissions.allow).toEqual(['Read(./existing.txt)']);
      await waitFor(() =>
        expect(view.lastFrame()).toContain('Failed to delete permission rule'),
      );
      fail = false;
      await act(async () => mocks.deleteRule!());
      expect(data.permissions.allow).toEqual([]);
      expect(mocks.apply).toHaveBeenCalledWith(
        expect.objectContaining({ destination: source, type: 'removeRules' }),
      );
      await waitFor(() =>
        expect(view.lastFrame({ allowEmpty: true })).not.toContain(
          'Failed to delete permission rule',
        ),
      );
      view.unmount();
    },
  );
});
