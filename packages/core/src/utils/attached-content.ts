/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Headers that open content qwen-code adds to a user turn on the user's
 * behalf: @-mentioned files, MCP resources and referenced sessions. The code
 * that writes each block and the compaction code that tells it apart from
 * what the user typed both use these, so the two cannot drift apart.
 */
export const REFERENCED_FILES_HEADER = '--- Content from referenced files ---';
export const MCP_RESOURCE_HEADER_PREFIX = '--- Content from MCP resource ';
export const REFERENCED_SESSION_HEADER_PREFIX = '--- Referenced session ';

const ATTACHED_CONTENT_HEADERS = [
  REFERENCED_FILES_HEADER,
  MCP_RESOURCE_HEADER_PREFIX,
  REFERENCED_SESSION_HEADER_PREFIX,
];

/** Whether `text` opens content attached on the user's behalf. */
export function opensAttachedContent(text: string): boolean {
  const start = text.trimStart();
  return ATTACHED_CONTENT_HEADERS.some((header) => start.startsWith(header));
}
