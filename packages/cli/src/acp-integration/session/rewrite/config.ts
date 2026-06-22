/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadedSettings } from '../../../config/settings.js';
import type { MessageRewriteConfig } from './types.js';

/**
 * Reads messageRewrite configuration from user/workspace originalSettings.
 * Workspace settings are only used when the workspace is trusted,
 * preventing untrusted repos from enabling the rewriter with a custom prompt.
 */
export function loadRewriteConfig(
  settings: LoadedSettings,
): MessageRewriteConfig | undefined {
  const userOriginal = settings.user?.originalSettings as
    | Record<string, unknown>
    | undefined;
  const workspaceOriginal = settings.isTrusted
    ? (settings.workspace?.originalSettings as
        | Record<string, unknown>
        | undefined)
    : undefined;
  return (workspaceOriginal?.['messageRewrite'] ??
    userOriginal?.['messageRewrite']) as MessageRewriteConfig | undefined;
}
