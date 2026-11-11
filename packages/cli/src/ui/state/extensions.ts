/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stub module — extension update state has been removed as part of the
 * Plugin migration. These minimal type exports keep dependent modules compiling.
 */

export enum ExtensionUpdateState {
  UNKNOWN = 'unknown',
  UP_TO_DATE = 'up to date',
}

export interface ExtensionUpdateStatus {
  status: ExtensionUpdateState;
  notified: boolean;
}

export type ExtensionUpdateAction = {
  type: string;
  payload?: unknown;
};
