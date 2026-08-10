/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SerializableConfirmationDetails } from '../../confirmation-bus/types.js';
import type { ToolCallConfirmationDetails } from '../../tools/tools.js';

export function serializeConfirmationDetails(
  details: ToolCallConfirmationDetails,
): SerializableConfirmationDetails {
  const { onConfirm: _onConfirm, ...serializable } = details;
  return serializable;
}
