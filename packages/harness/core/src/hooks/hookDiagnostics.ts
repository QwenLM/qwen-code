/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Static issues reported by existing configuration loaders and validators. */
export interface HookDiagnostic {
  code:
    | 'hook_validation_error'
    | 'settings_load_error'
    | 'plugin_hook_load_error'
    | 'hook_reload_error';
  message: string;
  event?: string;
  field?: string;
  /** 不透明条目关联键；仅对当前配置内容有效。 */
  hook_ref?: string;
}

export interface HookDiagnosticsSnapshot {
  /** Complete means reading completed, not that the hooks can execute successfully. */
  readStatus: 'complete' | 'partial' | 'failed';
  checkedAt: string;
  diagnostics: HookDiagnostic[];
}
