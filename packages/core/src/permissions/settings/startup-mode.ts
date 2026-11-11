/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import type { PermissionMode } from '../manager/decision/index.js';

const BYPASS_PERMISSIONS_DISABLED_MESSAGE =
  'Bypass permissions mode is disabled by settings. Falling back to "default".';

export interface StartupPermissionModeInput {
  /** --permission-mode 原始值；别名与大小写变体在这里归一。 */
  readonly flagMode?: string;
  /** settings.general.defaultPermissionMode 原始值。 */
  readonly settingsMode?: string;
  /** 已显式决策的嵌入模式；带它时不再解析 flag/settings。 */
  readonly explicitMode?: PermissionMode;
  readonly trustedFolder: boolean;
  readonly disableYoloMode: boolean;
}

export interface StartupPermissionModeDecision {
  readonly mode: PermissionMode;
  /** 用户在信任降级前请求的模式；目录受信任后用它恢复。 */
  readonly requestedMode: PermissionMode;
}

function normalize(raw: string): PermissionMode | undefined {
  switch (raw) {
    case 'bypass_permissions':
    case 'bypassPermissions':
    case 'yolo':
      return 'yolo';
    case 'accept_edits':
    case 'acceptEdits':
      return 'acceptEdits';
    case 'dontAsk':
    case 'dont_ask':
      return 'dontAsk';
    case 'default':
      return 'default';
    case 'auto':
      return 'auto';
    default:
      return undefined;
  }
}

/**
 * 会话启动模式的全部决策：flag/settings 来源、disableYolo 回退与不可信目录降级。
 * 创建会话权限时只依赖这里的结果。
 */
export function resolveStartupPermissionMode(
  input: StartupPermissionModeInput,
): StartupPermissionModeDecision {
  let mode: PermissionMode = 'default';

  if (input.explicitMode !== undefined) {
    mode = input.explicitMode;
    if (input.disableYoloMode && mode === 'yolo') {
      throw new Error(BYPASS_PERMISSIONS_DISABLED_MESSAGE);
    }
  } else {
    const raw = input.flagMode || input.settingsMode;
    if (raw) {
      const normalized = normalize(raw);
      if (normalized === undefined) {
        if (input.flagMode) {
          throw new Error(
            'Invalid permission mode: ' +
              raw +
              '. Valid values are: default, accept_edits, bypass_permissions, dont_ask, auto',
          );
        }
        runLogger.warn(
          'Invalid default permission mode "' + raw + '" in settings. Falling back to "default".',
        );
        mode = 'default';
      } else {
        mode = normalized;
      }
    }

    if (input.disableYoloMode && mode === 'yolo') {
      runLogger.warn(
        'Bypass permissions mode is disabled by settings. Falling back to "default".',
      );
      mode = 'default';
    } else if (mode === 'yolo') {
      runLogger.warn(
        'Bypass permissions mode is enabled. All tool calls will be automatically approved.',
      );
    }
  }

  const requestedMode = mode;
  if (!input.trustedFolder && mode !== 'default') {
    runLogger.warn(
      'Permission mode overridden to "default" because the current folder is not trusted.',
    );
    mode = 'default';
  }

  return { mode, requestedMode };
}
