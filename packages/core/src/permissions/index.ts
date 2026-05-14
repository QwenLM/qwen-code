/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './types.js';
export * from './rule-parser.js';
export { PermissionManager } from './permission-manager.js';
export type { PermissionManagerConfig } from './permission-manager.js';
export { extractShellOperations } from './shell-semantics.js';
export type { ShellOperation } from './shell-semantics.js';
export {
  evaluateAutoMode,
  type AutoModeDecision,
  type EvaluateAutoModeInput,
  SAFE_TOOL_ALLOWLIST,
  isInSafeToolAllowlist,
  passesAcceptEditsFastPath,
  shouldRunAutoModeForCall,
} from './autoMode.js';
export {
  type AutoModeDenialState,
  type DenialFallbackReason,
  AUTO_MODE_DENIAL_LIMITS,
  createDenialState,
  recordAllow,
  recordBlock,
  recordFallbackApprove,
  recordFallbackReject,
  recordUnavailable,
  resetDenialState,
  shouldFallback,
} from './denialTracking.js';
