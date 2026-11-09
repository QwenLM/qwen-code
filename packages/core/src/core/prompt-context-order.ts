/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import {
  AUTO_MEMORY_SNAPSHOT_METADATA,
  isWrappedSystemReminderPart,
} from './environmentContext.js';
import { REATTACH_BOUNDARY_METADATA } from '../services/image-payload-references.js';
import { isUserPromptSubmitContextPartText } from '../utils/transcript-records.js';

/**
 * Whether `part` is context this code injected into a user turn rather than
 * the caller's own content: a per-turn reminder, a UserPromptSubmit/Mod block,
 * or a marked memory catalog snapshot.
 *
 * Shape-based for the two text envelopes, the same trust model
 * `isSystemReminderContent` uses. Classification spans the whole entry, which
 * is what lets a mid-entry reminder bound the moving run; only the contiguous
 * injected run after the caller's last own part is relocated, so a
 * caller-authored part shaped like either envelope that ends the entry is
 * treated as injected and moves ahead of the caller's text.
 */
function isInjectedPromptContext(part: Part): boolean {
  return (
    isWrappedSystemReminderPart(part) ||
    isUserPromptSubmitContextPartText(part.text ?? '') ||
    part.partMetadata?.[AUTO_MEMORY_SNAPSHOT_METADATA] === true
  );
}

/**
 * Moves the injected context that trails a user entry's own text ahead of it,
 * so the user's instruction is the last thing the model reads.
 *
 * A fresh turn's entry is assembled from independent sources: per-turn
 * reminders ahead of the prompt, then hook/Mod context and the memory catalog
 * behind it. On a long multi-part instruction that sandwiches the real task in
 * the middle, and a model answered "no task received" while it sat there
 * (#16259). Leading reminders already precede the prompt, so only the
 * contiguous injected run AFTER the caller's last own part moves. Nothing else
 * is reordered: a reminder the caller placed between two of its own parts stays
 * there, keeping the caller's relative order intact.
 *
 * The trailing position is load-bearing for STORED history: the transcript
 * display projection and the resume receipt both read the hook block as the
 * final part. This therefore reorders only copies built for the wire, never
 * `history` itself.
 *
 * Every consumer that relies on cache-prefix identity with the main request
 * must apply it: the main request (all entries, not only the pending one) and
 * the compaction side-query's cache-sharing payload. A consumer that sends the
 * stored order re-prefills the whole history at full price.
 *
 * Two regions stay put. Leading `functionResponse` parts, because a
 * `tool_result` block must immediately follow the model's `tool_use`; and the
 * volatile tail from the first reattach marker onward, which is one contiguous
 * region (marker, then a label and an image per replayed image) that the
 * provider cache passes count as trailing blocks to place their breakpoint
 * before it (#11627).
 */
export function movePromptContextAheadOfUserText(
  contents: Content[],
): Content[] {
  // Every user entry takes the same shape, not only the pending one. The next
  // request re-sends earlier entries from history, so a position-dependent
  // shape would cut the shared prefix and re-bill the injected blocks uncached.
  return contents.map(movePromptContextAheadInEntry);
}

function movePromptContextAheadInEntry(content: Content): Content {
  const parts = content.parts;
  if (content.role !== 'user' || !parts || parts.length < 2) return content;
  const volatileStart = parts.findIndex(
    (part) => part.partMetadata?.[REATTACH_BOUNDARY_METADATA] === true,
  );
  const movableEnd = volatileStart === -1 ? parts.length : volatileStart;
  const isOwnPart = (part: Part) =>
    !part.functionResponse && !isInjectedPromptContext(part);
  // Only a LEADING tool-result run is positional. A functionResponse later in
  // the entry belongs to the caller's own ordering, so leave such an entry
  // alone rather than hoist the tool result to the front.
  const leadingEnd = parts.findIndex((part) => !part.functionResponse);
  if (
    leadingEnd !== -1 &&
    parts.slice(leadingEnd, movableEnd).some((part) => part.functionResponse)
  ) {
    return content;
  }
  const lastOwnIndex = parts.findLastIndex(
    (part, index) => index < movableEnd && isOwnPart(part),
  );
  if (lastOwnIndex === -1 || lastOwnIndex === movableEnd - 1) return content;
  // Walk back over the contiguous own run only. A reminder the caller placed
  // between two of its own parts bounds the run, so it keeps its position.
  let firstOwnIndex = lastOwnIndex;
  while (firstOwnIndex > 0 && isOwnPart(parts[firstOwnIndex - 1]!)) {
    firstOwnIndex--;
  }
  return {
    ...content,
    parts: [
      ...parts.slice(0, firstOwnIndex),
      ...parts.slice(lastOwnIndex + 1, movableEnd),
      ...parts.slice(firstOwnIndex, lastOwnIndex + 1),
      ...parts.slice(movableEnd),
    ],
  };
}
