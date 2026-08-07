/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Disclosure text delivery (decision D8): a lossy policy derivative must
 * reach the model with its disclosure IMMEDIATELY adjacent to the media
 * Part, so provider converters that relocate media (splitToolMedia) can
 * move the pair together and the model can attribute the disclosure to
 * the right resource.
 *
 * Deliberately a leaf module — imported by both the omni pipeline and the
 * OpenAI converter, so it must not pull in either side.
 */

/** Marks a text Part as a media-degradation disclosure. Converters key on
 * this prefix to keep the disclosure adjacent to its media part. */
export const OMNI_DISCLOSURE_TEXT_PREFIX = '【媒体降质】';

/** Model-facing disclosure text for one degraded resource. */
export function formatDisclosureText(
  displayName: string,
  disclosure: string,
): string {
  return `${OMNI_DISCLOSURE_TEXT_PREFIX}${displayName}：${disclosure}`;
}

/** Whether a text is a disclosure emitted by {@link formatDisclosureText}. */
export function isDisclosureText(text: string): boolean {
  return text.startsWith(OMNI_DISCLOSURE_TEXT_PREFIX);
}
