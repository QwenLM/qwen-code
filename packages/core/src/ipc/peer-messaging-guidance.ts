/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Describe only what a missing own peer identity establishes. */
export function peerMessagingOffReason(config: {
  isSafeMode?(): boolean;
}): string {
  if (config.isSafeMode?.()) {
    return '--safe-mode (or QWEN_CODE_SAFE_MODE) disables peer messaging, and agents.crossSessionMessaging may also be off';
  }
  return 'this session publishes no peer inbox address';
}
