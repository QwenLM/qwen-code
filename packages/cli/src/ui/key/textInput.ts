/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Key } from '../contexts/KeypressContext.js';

// Single-line fields must not consume C0/C1 control characters that happen to
// be coalesced into an otherwise insertable PTY text chunk.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f-\x9f]/u;

export function isSingleLineTextInput(key: Key): boolean {
  return (
    key.insertable &&
    key.sequence.length > 0 &&
    !key.alt &&
    !key.ctrl &&
    !key.cmd &&
    !CONTROL_CHARACTER_PATTERN.test(key.sequence)
  );
}
