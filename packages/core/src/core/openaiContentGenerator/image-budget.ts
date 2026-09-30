/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';

/**
 * Cap on the number of image parts in a single assembled request.
 *
 * Omni keyframes are delivered as `image_url` parts that persist in the
 * conversation history and are re-sent on every turn. Across a long
 * look-closer trajectory (many extract-keyframes / clip → read cycles) the
 * running count climbs until the backing API rejects the WHOLE request —
 * DashScope's qwen-omni caps at 256 images ("Too many images. The maximum
 * allowed is 256"), a hard 400 that no retry recovers. We keep a margin below
 * that limit so a request that also carries a few non-keyframe images (a
 * user-attached picture, a video's own frames) still lands under the ceiling.
 */
export const DEFAULT_MAX_REQUEST_IMAGES = 250;

/** Text left in place of an evicted image, so the message keeps a part and
 * the model learns why an earlier frame is gone rather than silently losing
 * it. */
const EVICTED_IMAGE_PLACEHOLDER =
  '[已淘汰较早的关键帧以控制单次请求的图片数量；如需重看该画面请重新抽帧或切片]';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

function isImagePart(part: unknown): boolean {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'image_url'
  );
}

/**
 * Keep only the newest `cap` image parts across the whole request, replacing
 * each older one with a short text placeholder in place. History is
 * chronological (earliest message first), so "oldest" = earliest array
 * position; the current turn's freshly-delivered frames are always retained.
 *
 * Counts `image_url` parts only. `video_url` parts are left untouched: a clip
 * delivered as native video is the high-value payload the model asked for, and
 * the observed 256 crashes come from accumulated keyframe images, not videos.
 *
 * Mutates `messages` in place and returns the number of images evicted.
 */
export function evictOldestImagesBeyondCap(
  messages: Message[],
  cap: number = DEFAULT_MAX_REQUEST_IMAGES,
): number {
  if (cap < 0) return 0;
  let total = 0;
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isImagePart(part)) total++;
      }
    }
  }
  if (total <= cap) return 0;

  let toEvict = total - cap;
  let evicted = 0;
  for (const message of messages) {
    if (toEvict === 0) break;
    if (!Array.isArray(message.content)) continue;
    const content = message.content as unknown as Array<
      Record<string, unknown>
    >;
    for (let i = 0; i < content.length && toEvict > 0; i++) {
      if (isImagePart(content[i])) {
        content[i] = { type: 'text', text: EVICTED_IMAGE_PLACEHOLDER };
        toEvict--;
        evicted++;
      }
    }
  }
  return evicted;
}
