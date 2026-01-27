/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PermissionResponsePayload {
  optionId: string;
}

export interface PermissionResponseMessage {
  type: string;
  data: PermissionResponsePayload;
}
