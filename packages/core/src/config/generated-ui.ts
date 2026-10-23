/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from './mcp-server-config.js';

export const BUNDLED_GENERATED_UI_SERVER = 'generated-ui';
export const BUNDLED_GENERATED_UI_TOOL = 'generated_ui_show';
export const BUNDLED_GENERATED_UI_URI =
  'ui://qwen-code-generated-ui/view-v1.html';

export interface BundledGeneratedUiStatus {
  version: 1;
  enabled: boolean;
  reason?:
    | 'setting-disabled'
    | 'unsupported-runtime'
    | 'workspace-untrusted'
    | 'provider-conflict'
    | 'assets-missing'
    | 'policy-disabled';
}

export interface BundledGeneratedUiConfig {
  enabled: boolean;
  server?: MCPServerConfig;
  skillsDir?: string;
  unavailableReason?: BundledGeneratedUiStatus['reason'];
}
