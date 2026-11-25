/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';

/**
 * Whether everything a cancelled turn left behind its prompt can go with it.
 * Thoughts count as nothing: cancelling mid-reasoning is exactly when taking
 * the prompt back matters, and the TUI's restore-on-cancel treats them the
 * same way. An answer, a tool call, shell output, a permission request or a
 * later user message all keep the turn.
 *
 * Only meaningful once the daemon has settled the turn: until its terminal
 * event arrives, "nothing received yet" is not "nothing produced".
 */
export function cancelledTurnProducedNothing(
  blocksAfterPrompt: readonly DaemonTranscriptBlock[],
): boolean {
  return blocksAfterPrompt.every(
    (block) =>
      block.kind === 'thought' ||
      block.kind === 'status' ||
      block.kind === 'error' ||
      block.kind === 'debug' ||
      block.kind === 'prompt_cancelled',
  );
}
