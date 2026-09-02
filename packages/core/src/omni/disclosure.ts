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

/**
 * The annotation grammar separates the display name from the payload with
 * a full-width colon — but a display name (a basename) may itself contain
 * one. Writers escape the name so a reader can split at the first
 * UNESCAPED separator instead of guessing; names without the separator
 * pass through unchanged, so the model-visible text is identical in the
 * common case.
 */
export function escapeAnnotationName(name: string): string {
  return name.replaceAll('\\', '\\\\').replaceAll('：', '\\：');
}

/** Inverse of {@link escapeAnnotationName}. */
export function unescapeAnnotationName(escaped: string): string {
  return escaped.replace(/\\([\s\S])/g, '$1');
}

/**
 * Split an annotation body `<escaped-name>：<payload>` at the first
 * unescaped separator. Returns undefined when no unescaped separator
 * exists (not an annotation body).
 */
export function splitAnnotationBody(
  body: string,
): { name: string; payload: string } | undefined {
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '：') {
      return {
        name: unescapeAnnotationName(body.slice(0, i)),
        payload: body.slice(i + 1),
      };
    }
  }
  return undefined;
}

/**
 * A bare keyframe timestamp label like `<00:11>` or `<1:02:03>` — the
 * adjacent text for one sampled frame (mirrors read_video's per-frame
 * `<timestamp>`). It deliberately carries NO 【媒体降质】<name>： prefix: the
 * shared degradation notice is stated once on the first frame's header, and
 * repeating the prefix on every one of N frames is pure noise. Anchored so
 * only a lone marker matches — the first frame's header (which begins with
 * 原视频…) does not.
 */
export function isKeyframeTimestampLabel(text: string): boolean {
  return /^<\d{1,2}:\d{2}(?::\d{2})?>$/.test(text);
}

/** Model-facing disclosure text for one degraded resource. */
export function formatDisclosureText(
  displayName: string,
  disclosure: string,
): string {
  // Bare per-frame timestamp markers are delivered clean — the one-time
  // degradation notice already rode on the first keyframe's header.
  if (isKeyframeTimestampLabel(disclosure)) {
    return disclosure;
  }
  return `${OMNI_DISCLOSURE_TEXT_PREFIX}${escapeAnnotationName(displayName)}：${disclosure}`;
}

/** Whether a text is a disclosure emitted by {@link formatDisclosureText}. */
export function isDisclosureText(text: string): boolean {
  // Bare timestamp markers carry no prefix, but must still travel WITH their
  // image when splitToolMedia relocates media out of a tool message.
  return (
    text.startsWith(OMNI_DISCLOSURE_TEXT_PREFIX) ||
    isKeyframeTimestampLabel(text)
  );
}

/** Marks a text Part as an explicit-omission notice: the transport guard
 * could not bring a resource within limits, so the media was withheld and
 * this text stands in its place (policy design §10.2). */
export const OMNI_OMISSION_TEXT_PREFIX = '【媒体省略】';

/** Model-facing omission notice for one withheld resource. */
export function formatOmissionText(
  displayName: string,
  reason: string,
): string {
  return `${OMNI_OMISSION_TEXT_PREFIX}${escapeAnnotationName(displayName)}：${reason}`;
}

/** Marks a text Part as a media transcript: a text derivative (upstream P
 * §6.2 transcript protocol, `metadata.omniRole: 'transcript'`) produced by
 * a fixed policy and delivered as text instead of (or alongside) the media
 * Part. */
export const OMNI_TRANSCRIPT_TEXT_PREFIX = '【媒体转写】';

/** Model-facing transcript text for one media resource. */
export function formatTranscriptText(
  displayName: string,
  transcript: string,
): string {
  return `${OMNI_TRANSCRIPT_TEXT_PREFIX}${escapeAnnotationName(displayName)}：${transcript}`;
}

/** Marks a text Part as a session resource annotation. It carries one of
 * two forms, both prefixed identically and told apart at parse time:
 *   - handle form ({@link formatResourceHandleText}): the opaque
 *     `resourceId` minted for the resource (memory design M §5.2) — used
 *     for path-less sources (tool/URL/recall media) whose real locator is
 *     an internal object-store path the model must never see;
 *   - path form ({@link formatResourcePathText}): the ABSOLUTE PATH of a
 *     model-visible local file, shown in place of the handle because the
 *     model already holds that path and can re-read it or point tools at
 *     it directly.
 * The model references whichever value it is shown in
 * `omni_recall_media_memory` (and other omni tools that accept a
 * resourceId / inputPath); recall resolves the path form back to the
 * session handle. */
export const OMNI_RESOURCE_HANDLE_TEXT_PREFIX = '【媒体资源】';

/** Model-facing resource-handle annotation for one delivered resource. */
export function formatResourceHandleText(
  displayName: string,
  resourceId: string,
): string {
  return `${OMNI_RESOURCE_HANDLE_TEXT_PREFIX}${escapeAnnotationName(displayName)}：${resourceId}`;
}

/** Extract the resourceId from a handle annotation emitted by
 * {@link formatResourceHandleText}, or undefined for any other text
 * (including the path form). The handle grammar is harness-minted
 * (`media-<n>-<hex>`), so parsing keys on it rather than on the displayName
 * (which may itself contain the separator).
 *
 * The split is located at the FIRST UNESCAPED separator via
 * {@link splitAnnotationBody} — an escape-blind end-anchored regex would
 * misread a path form whose filename ends in a handle-shaped suffix (e.g.
 * `/tmp/clip：media-3-9f2cabcd`, whose separator the writer ESCAPED) as a
 * handle. Only a payload matching the exact handle grammar is accepted, so
 * a genuine path can never masquerade as one. */
export function parseResourceHandleText(text: string): string | undefined {
  if (!text.startsWith(OMNI_RESOURCE_HANDLE_TEXT_PREFIX)) return undefined;
  const split = splitAnnotationBody(
    text.slice(OMNI_RESOURCE_HANDLE_TEXT_PREFIX.length),
  );
  if (!split) return undefined;
  return /^media-\d+-[0-9a-f]+$/.test(split.payload)
    ? split.payload
    : undefined;
}

/**
 * Model-facing resource annotation for media the model can re-read from a
 * real local path: the ABSOLUTE PATH stands in for the opaque handle. Used
 * when the source is a model-visible local file (the model already holds
 * the path and can read_file it or point tools at it directly), so an
 * opaque `media-<n>-<hex>` handle would be redundant noise. Recall (both
 * the active tool and the passive selector) recovers the session handle
 * from the path via `MediaResourceRegistry.resolveByFileRef` — the binding
 * is registered regardless of which form is shown. Path-less sources
 * (tool/URL media, whose real locator is an internal object-store path)
 * keep the handle form ({@link formatResourceHandleText}): no usable path
 * exists to show.
 *
 * Carries NO `：<payload>` separator, which is exactly how
 * {@link parseResourcePathText} tells it apart from the handle form.
 */
export function formatResourcePathText(absolutePath: string): string {
  return `${OMNI_RESOURCE_HANDLE_TEXT_PREFIX}${escapeAnnotationName(absolutePath)}`;
}

/**
 * Extract the absolute path from a path-form resource annotation emitted by
 * {@link formatResourcePathText}, or undefined for any other text —
 * including the handle form, which is disambiguated by its unescaped
 * `：<resourceId>` separator (absolute paths never contain the full-width
 * colon unescaped, and any that did would have been escaped by the writer).
 */
export function parseResourcePathText(text: string): string | undefined {
  if (!text.startsWith(OMNI_RESOURCE_HANDLE_TEXT_PREFIX)) return undefined;
  const body = text.slice(OMNI_RESOURCE_HANDLE_TEXT_PREFIX.length);
  // An unescaped separator marks the handle form (<name>：<resourceId>); the
  // path form has none.
  if (splitAnnotationBody(body) !== undefined) return undefined;
  return unescapeAnnotationName(body);
}
