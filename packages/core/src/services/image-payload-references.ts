/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, ContentListUnion } from '@google/genai';
import type { Part } from '@google/genai';
import { createHash } from 'node:crypto';
import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '../core/environmentContext.js';
import { approxBase64Bytes } from '../core/inlineMediaLimit.js';
import { getFunctionResponseParts } from './compactionInputSlimming.js';

const IMAGE_ID_LENGTH = 12;
// Anchor the match to the full output of `imageReferenceText` so only the
// markers eviction actually wrote resolve against the store. A bare
// `Image #<id>` echo (a model reply quoting the id, or a post-compaction
// summary that retained marker text) must not resurrect the stored payload.
const IMAGE_REFERENCE_PATTERN = new RegExp(
  `\\[Image #([a-f0-9]{${IMAGE_ID_LENGTH}}): [^\\]]+\\]`,
  'gi',
);

export interface StoredImagePayload {
  id: string;
  mimeType: string;
  data: string;
  bytes: number;
  displayName?: string;
}

export interface ImagePayloadStore {
  put(part: Part): StoredImagePayload;
  get(id: string): StoredImagePayload | undefined;
}

interface CollectedImage {
  stored: StoredImagePayload;
}

export class InMemoryImagePayloadStore implements ImagePayloadStore {
  private readonly images = new Map<string, StoredImagePayload>();

  put(part: Part): StoredImagePayload {
    const stored = imagePartToStoredPayload(part);
    this.images.set(stored.id, stored);
    return stored;
  }

  get(id: string): StoredImagePayload | undefined {
    return this.images.get(id);
  }
}

export function countAllInlineImages(contents: Content[]): number {
  let count = 0;
  for (const _image of inlineImageParts(contents)) count++;
  return count;
}

/**
 * Replace image payloads in-place with text references, storing the
 * originals in the provided store. This mutates the history so that
 * subsequent `countAllInlineImages` returns a lower count.
 *
 * Returns the stored payloads in order of appearance for downstream
 * reattach decisions.
 */
export function replaceImagePayloadsInPlace(
  contents: Content[],
  store: ImagePayloadStore,
  skipContent?: Content,
): StoredImagePayload[] {
  const replaced: StoredImagePayload[] = [];
  for (const { part, toolNested } of inlineImageParts(contents, skipContent)) {
    const stored = store.put(part);
    replaced.push(stored);
    part.text = imageReferenceText(stored);
    delete part.inlineData;
    // Vouch for the marker this eviction wrote, so a marker-shaped string
    // echoed by tool output or model prose cannot claim the same currency.
    if (!toolNested) {
      part.partMetadata = {
        ...part.partMetadata,
        [IMAGE_MARKER_METADATA]: stored.id,
      };
    }
  }
  return replaced;
}

/**
 * Build reattach parts from images replaced in the current pass and stored
 * payloads referenced by markers in `referencedContents`, even when the
 * current pass replaced nothing.
 */
export function buildReattachParts(
  replaced: StoredImagePayload[],
  maxRecentImages: number,
  referencedContents: Content[] = [],
  store?: ImagePayloadStore,
): Part[] {
  // One sweep feeds every id set below; the per-request cost of this function
  // is dominated by the marker regex over long histories.
  const markers = collectImageMarkers(referencedContents);
  const referencedIds = new Set(markers.map((marker) => marker.id));
  if (replaced.length === 0 && (!store || referencedIds.size === 0)) return [];
  const inlineIds = collectInlineImageIds(referencedContents);
  const last = referencedContents.at(-1);
  const lastIndex = referencedContents.length - 1;
  const lastReferencedIds = new Set(
    last?.role === 'user'
      ? markers
          .filter((marker) => marker.contentIndex === lastIndex)
          .map((marker) => marker.id)
      : [],
  );
  const candidates: CollectedImage[] = replaced
    .filter(
      (image) => !inlineIds.has(image.id) && !lastReferencedIds.has(image.id),
    )
    .map((stored) => ({ stored }));

  if (store) {
    for (const id of referencedIds) {
      if (inlineIds.has(id) || lastReferencedIds.has(id)) continue;
      const stored = store.get(id);
      if (stored) candidates.push({ stored });
    }
  }
  const recent = recentUniqueImages(candidates, maxRecentImages).map(
    ({ stored }) => stored,
  );
  const reattachLimit = Math.max(maxRecentImages, 1);
  if (store) {
    for (const id of lastReferencedIds) {
      if (inlineIds.has(id) || recent.some((image) => image.id === id)) {
        continue;
      }
      const stored = store.get(id);
      if (stored) {
        if (recent.length >= reattachLimit) recent.shift();
        recent.push(stored);
      }
    }
  }
  if (recent.length === 0) return [];
  const origins = classifyMarkerOrigins(referencedContents, markers);
  return [
    {
      text: reattachContextText(recent.map((img) => img.id)),
      partMetadata: { [REATTACH_BOUNDARY_METADATA]: true },
    },
    ...recent.flatMap((image) =>
      labeledReattachParts(image, origins.get(image.id) ?? 'earlier'),
    ),
  ];
}

/**
 * `partMetadata` key stamped on the marker part that eviction wrote for a
 * top-level image, recording the stored id. A replayed image is only labeled
 * as an attachment of the current prompt when its own marker carries this
 * stamp: marker-shaped text also appears in tool output, in model prose
 * folded into a recovery turn, and in post-compaction summaries, and none of
 * those writers may vouch for an older image's currency.
 *
 * Client-side bookkeeping only, like {@link REATTACH_BOUNDARY_METADATA}:
 * `LlmContentGenerator.stripPartFields` deletes `partMetadata` before the
 * request is built — at every level, nested `functionResponse.parts`
 * included — and the OpenAI-compatible converters never serialize it.
 * Tool-nested parts are deliberately left unstamped for semantics, not for
 * wire safety: nested markers are tool captures, which
 * {@link classifyMarkerOrigins} never grants the prompt label, so a stamp
 * there could not change any outcome.
 */
export const IMAGE_MARKER_METADATA = 'qwen-code:image-marker';

/**
 * `partMetadata` key stamped on the leading text marker of the volatile
 * reattach region. `buildReattachParts` re-generates that region on every
 * request, so the DashScope cache pass uses this marker to place the
 * conversation breakpoint *before* the reattached images instead of after
 * them — keeping the cached prefix stable across turns (issue #11627).
 * It is client-side metadata only: the OpenAI-compatible converters never
 * serialize `partMetadata`, and the native SDK generator strips it in
 * `LlmContentGenerator.stripPartFields` before the request is built, so it
 * never reaches the wire.
 */
export const REATTACH_BOUNDARY_METADATA = 'qwen-code:reattach-boundary';

/**
 * Number of trailing parts of the last content that belong to the reattach
 * region, or 0 when the request ends without one. Each reattach part (one
 * text marker, then a text label and an inline image per replayed image)
 * converts to exactly one OpenAI content block, so this equals the
 * trailing reattach block count on the wire.
 */
export function trailingReattachPartCount(contents: ContentListUnion): number {
  const last = Array.isArray(contents) ? contents.at(-1) : undefined;
  const parts =
    last && typeof last === 'object' && 'parts' in last
      ? last.parts
      : undefined;
  if (!Array.isArray(parts) || parts.length === 0) return 0;
  const firstMarked = parts.findIndex(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      part.partMetadata?.[REATTACH_BOUNDARY_METADATA] === true,
  );
  if (firstMarked === -1) return 0;
  return parts.length - firstMarked;
}

export function prepareImagePayloadsForRequest(
  contents: Content[],
  options: {
    maxRecentImages: number;
    preserveImagePartsForContentIndex?: number;
    preserveLastUserImagePartCount?: number;
    store: ImagePayloadStore;
  },
): Content[] {
  const referencedIds = collectReferencedImageIds(
    contents.at(-1) ? [contents.at(-1)!] : [],
  );
  const collected: CollectedImage[] = [];
  const transformed = contents.map((content, index) => {
    if (index === options.preserveImagePartsForContentIndex) {
      return content;
    }
    if (index === contents.length - 1 && content.role === 'user') {
      const preserveCount = options.preserveLastUserImagePartCount ?? 0;
      const preserveFrom = Math.max(
        0,
        (content.parts?.length ?? 0) - preserveCount,
      );
      return {
        ...content,
        parts: content.parts?.map((part, partIndex) =>
          partIndex >= preserveFrom
            ? part
            : transformPart(part, options.store, collected),
        ),
      };
    }
    return {
      ...content,
      parts: content.parts?.map((part) =>
        transformPart(part, options.store, collected),
      ),
    };
  });

  const reattachById = new Map<string, StoredImagePayload>();
  const recent = recentUniqueImages(collected, options.maxRecentImages);
  for (const image of recent) {
    reattachById.set(image.stored.id, image.stored);
  }
  for (const image of collected) {
    if (referencedIds.has(image.stored.id)) {
      reattachById.set(image.stored.id, image.stored);
    }
  }
  for (const id of referencedIds) {
    const stored = options.store.get(id);
    if (stored) {
      reattachById.set(stored.id, stored);
    }
  }

  if (reattachById.size === 0) {
    return transformed;
  }
  // This path writes no IMAGE_MARKER_METADATA stamp, so nothing it replays
  // can be labeled as an attachment of the current prompt.
  const origins = classifyMarkerOrigins(
    transformed,
    collectImageMarkers(transformed),
  );

  const reattachParts: Part[] = [
    {
      text: reattachContextText([...reattachById.keys()]),
    },
    ...[...reattachById.values()].flatMap((image) =>
      labeledReattachParts(image, origins.get(image.id) ?? 'earlier'),
    ),
  ];

  const last = transformed.at(-1);
  if (last?.role === 'user') {
    last.parts = [...(last.parts ?? []), ...reattachParts];
    return transformed;
  }

  return [...transformed, { role: 'user', parts: reattachParts }];
}

function transformPart(
  part: Part,
  store: ImagePayloadStore,
  collected: CollectedImage[],
): Part {
  if (isInlineImagePart(part)) {
    const stored = store.put(part);
    collected.push({ stored });
    return { text: imageReferenceText(stored) };
  }

  if (part.functionResponse) {
    const nestedParts = getFunctionResponseParts(part);
    if (!nestedParts) return part;
    return {
      ...part,
      functionResponse: {
        ...part.functionResponse,
        parts: nestedParts.map((nested) =>
          transformPart(nested, store, collected),
        ),
      },
    };
  }

  return part;
}

function collectInlineImageIds(contents: Content[]): Set<string> {
  const ids = new Set<string>();
  for (const { part } of inlineImageParts(contents)) {
    ids.add(imagePartToStoredPayload(part).id);
  }
  return ids;
}

function isInlineImagePart(part: Part): boolean {
  return Boolean(
    part.inlineData?.mimeType?.startsWith('image/') && part.inlineData.data,
  );
}

function* inlineImageParts(
  contents: Content[],
  skipContent?: Content,
): Generator<{ part: Part; toolNested: boolean }> {
  for (const content of contents) {
    if (content === skipContent) continue;
    for (const part of content.parts ?? []) {
      if (isInlineImagePart(part)) {
        yield { part, toolNested: false };
      }
      for (const inner of getFunctionResponseParts(part) ?? []) {
        if (isInlineImagePart(inner)) {
          yield { part: inner, toolNested: true };
        }
      }
    }
  }
}

/** One eviction marker found in `contents`, with where it was found. */
interface ImageMarker {
  id: string;
  contentIndex: number;
  /** The marker text sat inside a tool response's nested parts. */
  toolNested: boolean;
  /** Eviction itself wrote this marker (see IMAGE_MARKER_METADATA). */
  stamped: boolean;
}

function collectImageMarkers(contents: Content[]): ImageMarker[] {
  const markers: ImageMarker[] = [];
  const collect = (
    parts: Part[] | undefined,
    contentIndex: number,
    toolNested: boolean,
  ): void => {
    for (const part of parts ?? []) {
      for (const match of part.text?.matchAll(IMAGE_REFERENCE_PATTERN) ?? []) {
        const id = match[1]?.toLowerCase();
        if (!id) continue;
        markers.push({
          id,
          contentIndex,
          toolNested,
          stamped: part.partMetadata?.[IMAGE_MARKER_METADATA] === id,
        });
      }
      collect(getFunctionResponseParts(part), contentIndex, true);
    }
  };
  contents.forEach((content, contentIndex) => {
    collect(content.parts, contentIndex, false);
  });
  return markers;
}

function collectReferencedImageIds(contents: Content[]): Set<string> {
  return new Set(collectImageMarkers(contents).map((marker) => marker.id));
}

/** Where a replayed image came from, as the label states it. */
type ReattachOrigin = 'prompt' | 'turn' | 'earlier';

// Ordered stalest first: absent provenance an id is labeled by the weakest
// claim about it, so a marker-shaped echo can never upgrade an older image to
// "current". The prompt's own stamped marker is the one claim that overrides.
// Ids are content hashes, so re-attaching identical bytes in a later turn
// reuses an id an earlier turn already labeled stale — and only the stamp
// eviction writes into the prompt's part says those bytes are the attachment
// being answered now.
const ORIGIN_PRECEDENCE: readonly ReattachOrigin[] = [
  'earlier',
  'turn',
  'prompt',
];

const ORIGIN_LABEL: Record<ReattachOrigin, string> = {
  prompt: 'part of the current user turn',
  turn: 'captured earlier in the current user turn; may predate later changes',
  earlier: 'from an earlier user turn, NOT part of the current one',
};

function classifyMarkerOrigins(
  contents: Content[],
  markers: readonly ImageMarker[],
): Map<string, ReattachOrigin> {
  const turnStart = currentTurnStartIndex(contents);
  const origins = new Map<string, ReattachOrigin>();
  if (turnStart < 0) return origins;
  for (const marker of markers) {
    if (marker.contentIndex < turnStart) {
      origins.set(marker.id, 'earlier');
      continue;
    }
    // Only a marker eviction stamped into the prompt's own part says the user
    // attached that image to the prompt being answered now.
    const promptClaim =
      marker.contentIndex === turnStart && marker.stamped && !marker.toolNested;
    const origin: ReattachOrigin = promptClaim ? 'prompt' : 'turn';
    const known = origins.get(marker.id);
    if (
      known === undefined ||
      // A provenance-vouched prompt attachment outranks a stale label an
      // earlier turn's marker wrote for the same content hash.
      promptClaim ||
      ORIGIN_PRECEDENCE.indexOf(origin) < ORIGIN_PRECEDENCE.indexOf(known)
    ) {
      origins.set(marker.id, origin);
    }
  }
  return origins;
}

// Index of the content that starts the current user turn, or -1 when the
// history holds no user turn at all. A prompt merged with a preceding tool
// result (consecutive user contents are fused by `appendCuratedContent`) still
// starts the turn, so any part the user could have sent counts; a content made
// only of tool responses belongs to the turn but does not start it. On a
// tool-call continuation the last content is such a tool result, and a
// screenshot the user sent with the prompt still belongs to this turn and may
// have been evicted into a marker since.
function currentTurnStartIndex(contents: Content[]): number {
  for (let index = contents.length - 1; index >= 0; index--) {
    const content = contents[index];
    if (content?.role === 'user' && content.parts?.some(isUserSentPart)) {
      return index;
    }
  }
  // No prompt in view: fall back to the last content, as before.
  return contents.at(-1)?.role === 'user' ? contents.length - 1 : -1;
}

// Whether a part can start a user turn. The request path splices structural
// `<system-reminder>` scaffolding into tool-result contents — the active todo
// reminder (`client.ts`, before `createUserContent`) and the memory-recall
// prompt appended on the same branch — so "has a text part" alone would read a
// routine tool result as the prompt and label the prompt's own evicted
// attachment as an earlier turn's. Rejected per part, as `isApiUserPrompt`
// rejects reminder-only contents: a genuine prompt keeps its own text or image
// part next to a reminder, and still starts the turn.
function isUserSentPart(part: Part): boolean {
  if (part.functionResponse) return false;
  const text = part.text;
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  return !(
    trimmed.startsWith(SYSTEM_REMINDER_OPEN) &&
    trimmed.endsWith(SYSTEM_REMINDER_CLOSE)
  );
}

function recentUniqueImages(
  collected: CollectedImage[],
  maxRecentImages: number,
): CollectedImage[] {
  if (maxRecentImages <= 0) {
    return [];
  }
  const recent: CollectedImage[] = [];
  const seen = new Set<string>();
  for (let index = collected.length - 1; index >= 0; index--) {
    const image = collected[index];
    if (!image || seen.has(image.stored.id)) continue;
    seen.add(image.stored.id);
    recent.push(image);
    if (recent.length === maxRecentImages) break;
  }
  return recent.reverse();
}

function imagePartToStoredPayload(part: Part): StoredImagePayload {
  const data = part.inlineData?.data ?? '';
  const mimeType = part.inlineData?.mimeType ?? 'application/octet-stream';
  const hash = createHash('sha256')
    .update(mimeType)
    .update('\0')
    .update(data)
    .digest('hex');
  return {
    id: hash.slice(0, IMAGE_ID_LENGTH),
    mimeType,
    data,
    bytes: approxBase64Bytes(data),
    displayName: part.inlineData?.displayName,
  };
}

function imageReferenceText(stored: StoredImagePayload): string {
  return `[Image #${stored.id}: ${safeImageMimeType(stored.mimeType)}, ${stored.bytes} bytes]`;
}

function reattachContextText(ids: readonly string[]): string {
  return (
    'Images read earlier in this session, replayed for reference: ' +
    ids.map((id) => `Image #${id}`).join(', ') +
    '. Each image below is labeled with its origin: only one labeled' +
    ' "part of the current user turn" was attached to the prompt being answered now;' +
    ' those labeled "captured earlier in the current user turn" or' +
    ' "from an earlier user turn" are frozen snapshots that may be OUTDATED,' +
    ' do not treat them as current UI state.' +
    ' Images shown above this note are not the ones replayed below.'
  );
}

// A lone id list above N unlabeled images cannot be mapped back to them, so
// a one-image turn followed by several replays reads as "the old images are
// the new ones" (#12544). Label every replayed image on its own. A snapshot
// captured during this turn is a frozen frame too, so only an attachment of
// the prompt itself is labeled without a staleness caveat.
function labeledReattachParts(
  stored: StoredImagePayload,
  origin: ReattachOrigin,
): Part[] {
  return [
    { text: `Image #${stored.id}: ${ORIGIN_LABEL[origin]}` },
    storedImageToPart(stored),
  ];
}

function safeImageMimeType(mimeType: string): string {
  return /^image\/[a-z0-9.+-]{1,64}$/i.test(mimeType)
    ? mimeType.toLowerCase()
    : 'image/unknown';
}

function storedImageToPart(stored: StoredImagePayload): Part {
  return {
    inlineData: {
      mimeType: stored.mimeType,
      data: stored.data,
      displayName: stored.displayName,
    },
  };
}
