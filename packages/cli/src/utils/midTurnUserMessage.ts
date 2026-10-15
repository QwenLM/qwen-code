/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import { normalizePartList } from './normalize-part-list.js';

export const MID_TURN_USER_MESSAGE_PREFIX =
  '\n[User message received during tool execution]: ';

/** For a message that cut the model's streaming response short. */
export const MID_TURN_INTERRUPT_USER_MESSAGE_PREFIX =
  '\n[User message received while you were responding; your response was interrupted]: ';

/** For a message taken while the model responded, without cutting it short. */
export const MID_TURN_RESPONSE_USER_MESSAGE_PREFIX =
  '\n[User message received while you were responding]: ';

export function prefixMidTurnUserMessageParts(
  parts: PartListUnion,
  displayText: string,
  prefix = MID_TURN_USER_MESSAGE_PREFIX,
): Part[] {
  const partArray = normalizePartList(parts);
  if (partArray.length === 0) {
    return [{ text: `${prefix}${displayText}` }];
  }

  const [firstPart, ...rest] = partArray;
  if ('text' in firstPart && typeof firstPart.text === 'string') {
    return [
      {
        ...firstPart,
        text: `${prefix}${firstPart.text}`,
      },
      ...rest,
    ];
  }

  return [{ text: `${prefix}${displayText}` }, ...partArray];
}
