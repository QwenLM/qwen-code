/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './types.js';
export * from './rule-parser.js';
export { PermissionManager } from './permission-manager.js';
export type { PermissionManagerConfig } from './permission-manager.js';
export { AutoApproveClassifier } from './auto-approve-classifier.js';
export type {
  ClassifierResult,
  AutoApproveClassifierOptions,
} from './auto-approve-classifier.js';
export { extractShellOperations } from './shell-semantics.js';
export type { ShellOperation } from './shell-semantics.js';
