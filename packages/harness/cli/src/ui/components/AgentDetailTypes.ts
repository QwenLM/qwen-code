/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition, AgentSource, Config } from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';

export interface AgentDetailPageProps {
  agentName: string;
  description: string;
  definition: AgentDefinition;
  filePath?: string;
  source?: AgentSource;
  config: Config;
  settings: LoadedSettings;
  onClose: () => void;
  onSave?: () => void;
  onRunAgent?: (name: string, query: string) => void;
}

/** Final field descriptions shared by rendering, navigation, and persistence. */
export type AgentDetailField =
  | {
      type: 'select';
      key: string;
      label: string;
      path: string[];
      options: Array<{ label: string; value: unknown }>;
    }
  | {
      type: 'action';
      key: 'runAgent' | 'editAgent' | 'deleteAgent';
      label: string;
      actionLabel: string;
    };

export interface AgentDetailEditorProps extends AgentDetailPageProps {
  fields: readonly AgentDetailField[];
}
