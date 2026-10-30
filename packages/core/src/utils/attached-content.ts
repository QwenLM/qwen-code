/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

/**
 * Headers that open content qwen-code adds to a user turn on the user's
 * behalf: @-mentioned files, MCP resources and referenced sessions, the note
 * written for an MCP resource that returned nothing, and the context added for
 * an @-mentioned MCP server or extension. The code that writes each block and
 * the compaction code that tells it apart from what the user typed both use
 * these, so the two cannot drift apart.
 */
export const REFERENCED_FILES_HEADER = '--- Content from referenced files ---';
export const MCP_RESOURCE_HEADER_PREFIX = '--- Content from MCP resource ';
export const REFERENCED_SESSION_HEADER_PREFIX = '--- Referenced session ';
export const MCP_RESOURCE_NOTE_HEADER_PREFIX = '--- MCP resource ';
export const MCP_SERVER_HEADER_PREFIX = '--- MCP Server: ';
export const EXTENSION_HEADER_PREFIX = '--- Extension: ';

const ATTACHED_CONTENT_HEADERS = [
  REFERENCED_FILES_HEADER,
  MCP_RESOURCE_HEADER_PREFIX,
  REFERENCED_SESSION_HEADER_PREFIX,
  MCP_RESOURCE_NOTE_HEADER_PREFIX,
  MCP_SERVER_HEADER_PREFIX,
  EXTENSION_HEADER_PREFIX,
];

/** Whether `text` opens content attached on the user's behalf. */
export function opensAttachedContent(text: string): boolean {
  const start = text.trimStart();
  return ATTACHED_CONTENT_HEADERS.some((header) => start.startsWith(header));
}

/**
 * Sent after a message whose attachment could not be resolved. Compaction
 * keeps it beside the message's quote, since it is the one thing the summary
 * needs to know about that attachment.
 */
export const ATTACHMENT_PROCESSING_FAILURE_NOTICE =
  '[Attachment could not be processed]';

/**
 * `partMetadata` key on the part that holds what the user typed, stamped where
 * the prompt is built. Compaction keeps that part and treats every other part
 * of the turn as attached, whatever the layout: the CLI puts the prompt first
 * and the ACP session puts it last. Client-side only: the native generator
 * strips `partMetadata` and the other converters never serialize it, while
 * the session file keeps it, so a resumed session still has it.
 */
export const TYPED_PROMPT_METADATA = 'qwen-code:typed-prompt';

/** `part` marked as text the user typed. */
export function markTypedPrompt(part: Part): Part {
  return {
    ...part,
    partMetadata: { ...part.partMetadata, [TYPED_PROMPT_METADATA]: true },
  };
}

/** Whether `part` is a text part marked as what the user typed. */
export function isTypedPrompt(part: Part): boolean {
  return (
    part.partMetadata?.[TYPED_PROMPT_METADATA] === true &&
    typeof part.text === 'string' &&
    !part.thought &&
    !part.functionResponse
  );
}
