/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The URI a session-attachment resource reference expands to. Persisted
// transcripts and the replay journal match on this exact string, so the
// format must never change. Kept in a dependency-free module so the replay
// matcher and the attachment store share it without pulling in node:fs.
export function attachmentResourceUri(attachmentId: string): string {
  return `attachment:///${encodeURIComponent(attachmentId)}`;
}
