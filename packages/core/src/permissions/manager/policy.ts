/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** 企业/组织策略在会话判定里的中性快照，不绑定具体下发通道。 */
export interface PermissionPolicySnapshot {
  readonly disabledModes: string[];
  readonly disabledModeMessages?: Readonly<
    Record<string, string | undefined>
  >;
  readonly rules?: {
    readonly deny: readonly string[];
    readonly ask: readonly string[];
  };
}

/** 会话请求的模式被企业策略禁用。 */
export class PermissionModeUnavailableError extends Error {
  override name = 'PermissionModeUnavailableError';
  /** wire 错误码保持既有值，host 按它分流处理。 */
  readonly code = 'GLOBAL_PERMISSION_MODE_DISABLED';
}
