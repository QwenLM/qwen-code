/**
 * Helpers for persisting and hydrating session-input attachments.
 *
 * Two tracks, chosen per attachment at save time:
 *   - Track P (path-backed): absolute OS path captured via webUtils.getPathForFile.
 *     Persist just `{path, name}`. Re-read on hydrate via the readUserAttachment RPC.
 *   - Track C (content-backed): no real path exists (paste, web-drag). Persist the
 *     bytes inline in `ref.content`. Hydrate reconstructs the FileAttachment from
 *     the stored bytes, no disk read.
 *
 * The detection criterion is `isAbsolutePath(a.path)`. File-picker and OS-drag go
 * through `webUtils.getPathForFile` (exposed on `electronAPI.getFilePath`) which
 * returns the absolute path. Paste/web-drag keep the filename-only synthetic path.
 */

import type { FileAttachment } from '@craft-agent/shared/protocol'
import type { DraftAttachmentContent, DraftAttachmentRef } from '@craft-agent/shared/config'

/** Per-attachment cap on inlined draft content. Huge pastes are dropped from the draft
 *  (with a warn) rather than bloating drafts.json. Tuned to the same 20 MB limit the
 *  shared readFileAttachment helper uses for file reads. */
export const CONTENT_PERSIST_CAP = 20 * 1024 * 1024

export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  return false
}

/**
 * Estimate the persisted byte cost of an attachment. base64 inflates ~33% over raw.
 * Used for the 20 MB cap check before we commit it to drafts.json.
 */
function estimateContentBytes(a: FileAttachment): number {
  const base64Bytes = a.base64 ? Math.floor(a.base64.length * 0.75) : 0
  const textBytes = a.text ? a.text.length : 0
  return Math.max(base64Bytes, textBytes)
}

function buildContent(a: FileAttachment): DraftAttachmentContent {
  return {
    type: a.type,
    mimeType: a.mimeType,
    size: a.size,
    ...(a.base64 !== undefined ? { base64: a.base64 } : {}),
    ...(a.text !== undefined ? { text: a.text } : {}),
    ...(a.thumbnailBase64 !== undefined ? { thumbnailBase64: a.thumbnailBase64 } : {}),
  }
}

/**
 * Turn a live `FileAttachment` into the persisted `DraftAttachmentRef`, picking
 * Track P or Track C based on whether the attachment has a real OS path.
 *
 * Returns `null` for Track C attachments whose content exceeds the per-attachment
 * cap — the caller drops it from the draft with a console warn.
 */
export function toDraftRef(a: FileAttachment): DraftAttachmentRef | null {
  if (isAbsolutePath(a.path)) {
    return { path: a.path, name: a.name }
  }
  if (estimateContentBytes(a) > CONTENT_PERSIST_CAP) {
    return null
  }
  return { path: a.path, name: a.name, content: buildContent(a) }
}

/**
 * Reconstruct a `FileAttachment` from a content-backed draft ref. Pure data
 * transformation — no disk read, no RPC.
 */
export function attachmentFromContentRef(ref: DraftAttachmentRef): FileAttachment | null {
  if (!ref.content) return null
  return {
    type: ref.content.type,
    path: ref.path,
    name: ref.name,
    mimeType: ref.content.mimeType,
    size: ref.content.size,
    base64: ref.content.base64,
    text: ref.content.text,
    thumbnailBase64: ref.content.thumbnailBase64,
  }
}
