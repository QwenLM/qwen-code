/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeOptions } from '@qwen-code/acp-bridge/bridgeOptions';
import {
  matchesRule,
  parseRule,
} from '@qwen-code/qwen-code-core/permissions/rule-parser.js';
import { ToolNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import { normalizeDisabledToolList } from '../config/normalizeDisabledTools.js';
import { readSettingsSnapshot } from '../config/settings.js';

export function readTrustedWorkflowSettings(
  workspaceCwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
) {
  try {
    const { tools, permissions } = readSettingsSnapshot(workspaceCwd, {
      environment,
      workspaceTrusted: true,
    }).merged;
    return {
      enabled:
        typeof tools?.workflowsEnabled === 'boolean'
          ? tools.workflowsEnabled
          : undefined,
      toolDenied:
        normalizeDisabledToolList(tools?.disabled).includes(
          ToolNames.WORKFLOW,
        ) ||
        [
          ...normalizeDisabledToolList(permissions?.deny),
          ...normalizeDisabledToolList(tools?.exclude),
        ].some((rule) => matchesRule(parseRule(rule), ToolNames.WORKFLOW)),
    };
  } catch {
    return null;
  }
}

export function bindDefaultSessionEngine(
  executionEngines: BridgeOptions['executionEngines'],
  workspaceCwd: string,
) {
  return (
    executionEngines &&
    (() =>
      executionEngines.select({
        operation: 'spawn',
        request: { workspaceCwd },
        daemonOwnedStandalone: false,
      }))
  );
}
