/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Replicating the bits of UpdateInfo we need from update-notifier
export interface UpdateInfo {
  latest: string;
  current: string;
  name: string;
  type?: string;
}

export type UpdateStatus = 'updating' | 'success' | 'failed';

export interface UpdateObject {
  message: string;
  update: UpdateInfo;
  isUpdating?: boolean;
  /** Current display status — drives the header inline indicator. */
  status?: UpdateStatus;
}
