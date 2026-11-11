/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/core';

// This method is intentionally misleading while we migrate.
// Once getUseTerminalBuffer() is always enabled we will refactor to remove
// all instances of this method making it the only path.
// Right now this is convenient as it allows us to special case terminalBuffer
// rendering like we special case alternateBuffer rendering.
export const isAlternateBufferEnabled = (_config: Config): boolean =>
  // CC Ink engine does not support ResizeObserver / triggerResizeObservers,
  // which the VirtualizedList / ScrollableList path depends on. Forcing this
  // to false makes MainContent use the <Static> rendering path instead, which
  // works correctly with CC Ink's diff-based renderer.
  // TODO: Re-enable when CC Ink's render pipeline supports ResizeObserver.
  false;
