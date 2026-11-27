/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_LOCAL_SUBAGENT_MAX_TURNS } from '@qwen-code/core';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import type { AgentDetailField } from './AgentDetailTypes.js';

export function createAgentEnabledField(): AgentDetailField {
  return {
    key: 'enabled',
    label: 'Enabled',
    path: ['enabled'],
    type: 'select',
    options: [
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ],
  };
}

export function createAgentModelField(
  modelOptions: Array<{ label: string; value: unknown }>,
): AgentDetailField {
  return {
    key: 'model',
    label: 'Model',
    path: ['modelConfig', 'model'],
    type: 'select',
    options: modelOptions,
  };
}

export function createAgentExecutionFields(): AgentDetailField[] {
  return [
    {
      key: 'maxTurns',
      label: 'Max Turns',
      path: ['runConfig', 'maxTurns'],
      type: 'select',
      options: [
        { label: '5', value: 5 },
        { label: '10', value: 10 },
        { label: '25', value: 25 },
        { label: '50', value: 50 },
        { label: '100', value: 100 },
        {
          label: `${DEFAULT_LOCAL_SUBAGENT_MAX_TURNS} (default)`,
          value: undefined,
        },
        { label: '200', value: 200 },
        { label: '300', value: 300 },
        { label: '500', value: 500 },
        { label: '1000', value: 1000 },
      ],
    },
    {
      key: 'maxTimeMinutes',
      label: 'Max Time (min)',
      path: ['runConfig', 'maxTimeMinutes'],
      type: 'select',
      options: [
        { label: 'default', value: undefined },
        { label: '5', value: 5 },
        { label: '10', value: 10 },
        { label: '30', value: 30 },
        { label: '60', value: 60 },
      ],
    },
    {
      key: 'runAgent',
      label: 'Run Agent',
      type: 'action',
      actionLabel: `⏎ ${SHORTCUT_HINTS.ENTER_RUN}`,
    },
    {
      key: 'editAgent',
      label: 'Edit Source',
      type: 'action',
      actionLabel: `⏎ ${SHORTCUT_HINTS.ENTER_EDIT}`,
    },
    {
      key: 'deleteAgent',
      label: 'Delete Agent',
      type: 'action',
      actionLabel: `⏎ ${SHORTCUT_HINTS.ENTER_DELETE_ITEM}`,
    },
  ];
}
