/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type ResourceKind =
  | 'mcp'
  | 'skill'
  | 'command'
  | 'hook'
  | 'agent'
  | 'outputStyle'
  | 'plugin';

export type ResourceSource =
  | 'user'
  | 'project'
  | 'local'
  | 'plugin'
  | 'additional'
  | 'flag'
  | 'builtIn';

export type ResourceOperation = 'add' | 'change' | 'unlink' | 'refresh';

export interface ResourceChangeEvent {
  kind: ResourceKind;
  source?: ResourceSource;
  path: string;
  operation: ResourceOperation;
  resourceName?: string;
}
