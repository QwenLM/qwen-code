/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { AgentDetailEditor } from './AgentDetailEditor.js';
import type {
  AgentDetailField,
  AgentDetailPageProps,
} from './AgentDetailTypes.js';
import {
  createAgentEnabledField,
  createAgentModelField,
  createAgentExecutionFields,
} from './agentDetailFields.js';

export type AgentDetailViewProps = AgentDetailPageProps;

function buildCliAgentDetailFields(): AgentDetailField[] {
  return [
    createAgentEnabledField(),
    createAgentModelField([{ label: 'inherit', value: 'inherit' }]),
    {
      key: 'temperature',
      label: 'Temperature',
      path: ['modelConfig', 'generateContentConfig', 'temperature'],
      type: 'select',
      options: [
        { label: 'default', value: undefined },
        { label: '0.0', value: 0.0 },
        { label: '0.2', value: 0.2 },
        { label: '0.4', value: 0.4 },
        { label: '0.7', value: 0.7 },
        { label: '1.0', value: 1.0 },
        { label: '1.5', value: 1.5 },
        { label: '2.0', value: 2.0 },
      ],
    },
    {
      key: 'topP',
      label: 'Top P',
      path: ['modelConfig', 'generateContentConfig', 'topP'],
      type: 'select',
      options: [
        { label: 'default', value: undefined },
        { label: '0.1', value: 0.1 },
        { label: '0.5', value: 0.5 },
        { label: '0.8', value: 0.8 },
        { label: '0.9', value: 0.9 },
        { label: '0.95', value: 0.95 },
        { label: '1.0', value: 1.0 },
      ],
    },
    {
      key: 'topK',
      label: 'Top K',
      path: ['modelConfig', 'generateContentConfig', 'topK'],
      type: 'select',
      options: [
        { label: 'default', value: undefined },
        { label: '1', value: 1 },
        { label: '5', value: 5 },
        { label: '10', value: 10 },
        { label: '20', value: 20 },
        { label: '40', value: 40 },
        { label: '64', value: 64 },
      ],
    },
    {
      key: 'maxOutputTokens',
      label: 'Max Output Tokens',
      path: ['modelConfig', 'generateContentConfig', 'maxOutputTokens'],
      type: 'select',
      options: [
        { label: 'default', value: undefined },
        { label: '1024', value: 1024 },
        { label: '2048', value: 2048 },
        { label: '4096', value: 4096 },
        { label: '8192', value: 8192 },
        { label: '16384', value: 16384 },
        { label: '65536', value: 65536 },
      ],
    },
    ...createAgentExecutionFields(),
  ];
}

export function AgentDetailView(
  props: AgentDetailViewProps,
): React.JSX.Element {
  const fields = useMemo(
    () => (props.source === 'plugin' ? [] : buildCliAgentDetailFields()),
    [props.source],
  );
  return <AgentDetailEditor {...props} fields={fields} />;
}
