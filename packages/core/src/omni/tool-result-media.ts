/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { clampInlineMediaPart } from '../core/inlineMediaLimit.js';
import { isImagePart } from '../services/visionBridge/image-part-utils.js';
import { boundImageBuffer, ImageViewError } from '../utils/image-view.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  buildAdditionalMediaParts,
  buildTranscriptParts,
  isOmniDeliveryActive,
  processMediaForOmniDelivery,
} from './index.js';
import {
  formatDisclosureText,
  formatOmissionText,
  formatResourceHandleText,
} from './disclosure.js';
import { OmniTransportGuardError } from './guard.js';
import { OmniObjectStore, prepareOmniDownloadsDir } from './storage.js';
import { sniffMediaType } from './recognition.js';

const debugLogger = createDebugLogger('omni:tool-result');

/** Upload-count budget per tool result (excess parts stay inline). */
const MAX_UPLOADS_PER_TOOL_RESULT = 8;
/** Aggregate upload-byte budget per tool result. */
const MAX_UPLOAD_BYTES_PER_TOOL_RESULT = 128 * 1024 * 1024;

/**
 * Recovery advice for a declined image dropped from a tool result. The
 * shared default points the user at an `@file` path, which cannot exist for
 * bytes that live only inside a tool response.
 */
const DECLINED_MEDIA_REMEDY =
  'Ask the user to have the tool return a smaller or lower-resolution payload.';

/**
 * Bound an image the funnel is about to keep inline. Producer-side bounding
 * (e.g. `DiscoveredMCPTool.boundInlineParts`) is skipped precisely because
 * this funnel is contracted to take over the bytes — a premise that only
 * holds on the upload branches. Every keep-inline exit still delivers the
 * ORIGINAL bytes inline, so the bound the producer forgone is applied here:
 * the same visual budget and the same trailing inline clamp, fail-open on a
 * renderer failure (an abort still propagates). Uploaded parts never reach
 * this helper — they are already `fileData` — so the omni "upload the
 * ORIGINAL bytes, no local resize" contract is untouched.
 */
async function boundDeclinedInlineImage(
  part: Part,
  bytes: Buffer,
  signal: AbortSignal,
): Promise<Part> {
  const inline = part.inlineData;
  if (!inline?.data) return part;
  let boundedPart = part;
  try {
    const view = await boundImageBuffer(
      bytes,
      `tool-result media (${inline.mimeType ?? 'unknown'})`,
      signal,
    );
    if (view) {
      boundedPart = {
        inlineData: {
          ...inline,
          data: view.bytes.toString('base64'),
          mimeType: view.mimeType,
        },
      };
    }
  } catch (error) {
    if (!(error instanceof ImageViewError)) {
      throw error;
    }
    debugLogger.debug(
      `tool-result media kept inline could not be bounded: ${error.message}`,
    );
  }
  // Only what ends up image-typed is subject to the inline byte limit: an
  // untyped blob the renderer could not decode stays verbatim (the
  // producer-side pipeline's rule, mirrored).
  return isImagePart(boundedPart)
    ? clampInlineMediaPart(boundedPart, undefined, {
        remedy: DECLINED_MEDIA_REMEDY,
      })
    : boundedPart;
}

/**
 * Second normalization trigger point (design §5.2/§8.2): tool-result media
 * flows through the same recognize → guard → store → upload pipeline as
 * user input, converting inline base64 Parts into oss:// fileData Parts.
 *
 * Invoked from BOTH physical funnels — CoreToolScheduler's terminal sites
 * and ACP Session.runTool — as a sibling of the vision-bridge processing
 * (never mixed into it: converted fileData parts are invisible to
 * isImagePart, so the bridge correctly skips them).
 *
 * Contract mirrors processToolResultImages:
 * - returns the ORIGINAL array identity when nothing changed (callers use
 *   `response !== convertedResponse` to decide whether to recompute
 *   content-length accounting);
 * - failure of any single part leaves that part inline (tool results were
 *   produced locally and already fit in memory — degrading to the S1-era
 *   inline behavior is safe here, unlike user-input delivery where inline
 *   silently violates the size contract; the failure is logged) — EXCEPT
 *   transport-guard rejections, which are policy verdicts rather than
 *   transfer failures: those parts are withheld with a text placeholder,
 *   never delivered inline (that would bypass the enabled guard);
 * - an IMAGE kept inline by any decline exit is bounded first
 *   (`boundDeclinedInlineImage`): producers skip their own bounding because
 *   this funnel is contracted to take over the bytes, so a decline must not
 *   strand the source-resolution original on the inline path;
 * - user aborts propagate.
 */
export async function processToolResultOmniMedia(
  responseParts: Part[],
  config: Config,
  signal: AbortSignal,
): Promise<Part[]> {
  if (!isOmniDeliveryActive(config)) return responseParts;

  const modalities = config.getContentGeneratorConfig?.()?.modalities ?? {};
  let changed = false;
  // Per-tool-result upload budget: a malicious/compromised tool must not
  // be able to fan out an unbounded number of uploads (cost/quota burn,
  // multi-minute stalls) from a single result. Parts over budget stay
  // inline (safe: they were produced locally and already fit in memory).
  let uploadsRemaining = MAX_UPLOADS_PER_TOOL_RESULT;
  let uploadBytesRemaining = MAX_UPLOAD_BYTES_PER_TOOL_RESULT;

  /** Keep-inline exit for a part the funnel declines to upload. An image
   * must still leave bounded: the producer-side bound was skipped on the
   * premise that this funnel takes over the bytes, so an unbounded decline
   * would deliver the source-resolution original inline. Non-image parts
   * keep the historical verbatim pass-through. */
  const keepInline = async (
    part: Part,
    bytes: Buffer,
    isImage: boolean,
  ): Promise<Part[]> => {
    if (!isImage) return [part];
    const kept = await boundDeclinedInlineImage(part, bytes, signal);
    if (kept !== part) changed = true;
    return [kept];
  };

  /** Returns the replacement Parts for one Part: `[part]` (unchanged),
   * `[fileData]`, or `[disclosureText, fileData]` when a fixed policy
   * degraded the media — the disclosure must sit IMMEDIATELY before its
   * media part (decision D8) so converters can move the pair together. */
  const convertPart = async (part: Part): Promise<Part[]> => {
    const inline = part.inlineData;
    if (!inline?.data || !inline.mimeType) return [part];
    const top = inline.mimeType.split('/')[0];
    if (top !== 'image' && top !== 'audio' && top !== 'video') {
      // An untyped blob (an MCP resource whose mime the server omitted,
      // defaulted to application/octet-stream) can still carry image bytes:
      // the producer-side bound admits exactly those by sniffing, so one
      // the funnel declines must not stay inline unbounded on the strength
      // of its missing label. Other non-media tops pass through verbatim.
      if (inline.mimeType === 'application/octet-stream') {
        const bytes = Buffer.from(inline.data, 'base64');
        if (sniffMediaType(bytes.subarray(0, 4096))?.modality === 'image') {
          return keepInline(part, bytes, true);
        }
      }
      return [part];
    }

    // Sniff the decoded bytes before touching disk — non-media or
    // unsupported containers stay inline untouched. The SNIFFED modality
    // is the authoritative gate: a part declared audio/* whose bytes are
    // actually a video container must not slip past a video-disabled
    // config on the strength of its declared MIME type.
    const bytes = Buffer.from(inline.data, 'base64');
    const sniffed = sniffMediaType(bytes.subarray(0, 4096));
    if (!sniffed) {
      // A declared image the sniffer cannot place may still decode in the
      // renderer; attempt the bound fail-open rather than deliver the
      // original bytes inline unbounded on the strength of a failed sniff.
      return keepInline(part, bytes, top === 'image');
    }
    if (!modalities[sniffed.modality]) {
      return keepInline(part, bytes, sniffed.modality === 'image');
    }
    if (uploadsRemaining <= 0 || bytes.length > uploadBytesRemaining) {
      debugLogger.debug(
        `tool-result media budget exhausted; keeping part inline (${bytes.length} bytes)`,
      );
      return keepInline(part, bytes, sniffed.modality === 'image');
    }

    // Everything from staging-dir setup onward sits inside the try: mkdir
    // itself can fail (ENOSPC, EACCES on ~/.qwen, ~/.qwen/omni existing as a
    // regular file → ENOTDIR), and the contract is that failure of any single
    // part leaves THAT part inline — not that the whole tool result rejects,
    // which would report a tool that succeeded as failed.
    const store = new OmniObjectStore(config.storage.getQwenDir());
    let tempPath: string | undefined;
    // Hoisted out of the try: the guard-rejection path below names the part
    // in the handle annotation it emits.
    const displayName = inline.displayName ?? `tool-media.${top}`;
    try {
      // Symlink-guarded (fail closed → this part stays inline): a link
      // planted at downloads/ would redirect the write outside the store.
      const stagingDir = await prepareOmniDownloadsDir(
        path.join(store.getOmniRootDir(), 'downloads'),
      );
      tempPath = path.join(
        stagingDir,
        `${randomBytes(8).toString('hex')}.part`,
      );
      await fs.writeFile(tempPath, bytes, { mode: 0o600 });
      const delivery = await processMediaForOmniDelivery(tempPath, config, {
        expectedModality: sniffed.modality,
        signal,
        displayName,
        origin: 'tool',
      });
      // §6.2/D8 ordering contract documented on buildTranscriptParts.
      const transcriptParts: Part[] = buildTranscriptParts(
        displayName,
        delivery.transcripts,
      );
      // Additional media Parts (multi-output fixed policies): follow the
      // primary media slot in every branch below. Each non-omitted extra
      // is a real upload the pipeline already performed — charge it
      // against the per-result upload-count budget so a multi-output
      // policy cannot multiply a tool result's fan-out past the cap
      // (extras carry no byte size, so only the count budget applies).
      const additionalParts: Part[] = buildAdditionalMediaParts(
        displayName,
        delivery.additionalMedia,
      );
      uploadsRemaining -=
        delivery.additionalMedia?.filter((e) => !e.omission).length ?? 0;
      // Session resource handle (M §5.2): leads the replacement group in
      // every branch, keeping the disclosure's D8 adjacency to the media
      // part intact.
      const handleParts: Part[] = delivery.resourceId
        ? [
            {
              text: formatResourceHandleText(displayName, delivery.resourceId),
            },
          ]
        : [];
      if (delivery.omission) {
        // Explicit omission (policy design §10.2): the transport guard
        // could not bring the part within limits even after the guard
        // policies ran — the media is withheld, the notice stands in for
        // it, and nothing was uploaded FOR THE PRIMARY (uploaded extras
        // were already charged above).
        changed = true;
        return [
          ...handleParts,
          { text: formatOmissionText(displayName, delivery.omission.reason) },
          ...additionalParts,
          ...transcriptParts,
        ];
      }
      if (!delivery.fileUri && transcriptParts.length > 0) {
        // Pure-transcript delivery (§6.2): the policies replaced the media
        // with text-only deliverables — nothing was uploaded for the
        // primary (uploaded extras were already charged above). The
        // primary disclosure (chained prior lossy steps, decision D8)
        // still renders: the transcript was derived through those steps.
        changed = true;
        return delivery.disclosure
          ? [
              ...handleParts,
              { text: formatDisclosureText(displayName, delivery.disclosure) },
              ...additionalParts,
              ...transcriptParts,
            ]
          : [...handleParts, ...additionalParts, ...transcriptParts];
      }
      changed = true;
      uploadsRemaining--;
      uploadBytesRemaining -= bytes.length;
      const fileDataPart: Part = {
        fileData: {
          fileUri: delivery.fileUri,
          mimeType: delivery.mimeType,
          displayName,
        },
      };
      return delivery.disclosure
        ? [
            ...handleParts,
            { text: formatDisclosureText(displayName, delivery.disclosure) },
            fileDataPart,
            ...additionalParts,
            ...transcriptParts,
          ]
        : [
            ...handleParts,
            fileDataPart,
            ...additionalParts,
            ...transcriptParts,
          ];
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof OmniTransportGuardError) {
        // A guard rejection is a policy verdict, not a transfer failure —
        // keeping the part inline would deliver the exact bytes the guard
        // was configured to reject (at greater request cost than the
        // upload). Withhold the media and say so; the inline-degradation
        // rationale ("produced locally, already in memory") covers only
        // failures of the *transfer*.
        changed = true;
        // The source was bound before the guard ruled, and the omission
        // branch with the identical "over-limit, withheld" verdict does
        // disclose its handle — so withholding it here would be the one
        // path that strands a resource the session already recorded.
        return [
          ...(err.sessionResourceId
            ? [
                {
                  text: formatResourceHandleText(
                    displayName,
                    err.sessionResourceId,
                  ),
                },
              ]
            : []),
          {
            text: `[Tool media part withheld by the omni transport guard: ${err.message}]`,
          },
        ];
      }
      debugLogger.debug(
        `tool-result media upload failed, keeping inline: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return keepInline(part, bytes, sniffed.modality === 'image');
    } finally {
      if (tempPath !== undefined) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
      }
    }
  };

  const result: Part[] = [];
  for (const part of responseParts) {
    const nested = part.functionResponse?.parts;
    if (Array.isArray(nested) && nested.length > 0) {
      const convertedNested: Part[] = [];
      let nestedChanged = false;
      for (const nestedPart of nested as Part[]) {
        const converted = await convertPart(nestedPart);
        if (converted.length !== 1 || converted[0] !== nestedPart) {
          nestedChanged = true;
        }
        convertedNested.push(...converted);
      }
      if (nestedChanged) {
        result.push({
          ...part,
          functionResponse: {
            ...part.functionResponse,
            parts: convertedNested,
          },
        } as Part);
        changed = true;
      } else {
        result.push(part);
      }
      continue;
    }
    result.push(...(await convertPart(part)));
  }

  return changed ? result : responseParts;
}
