/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AtMention {
  value: string;
  quoted: boolean;
}

/** Only explicit, boundary-delimited mentions; emails and escaped @ stay text. */
export function parseAtMentions(input: string): AtMention[] {
  const mentions: AtMention[] = [];
  const pattern = /(^|[\s。！？、])@(?:"([^"]+)"|([^\s"]+))/g;
  for (const match of input.matchAll(pattern)) {
    mentions.push({
      value: match[2] ?? match[3],
      quoted: match[2] !== undefined,
    });
  }
  return mentions;
}
