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

  /** Returns the replacement Parts for one Part: `[part]` (unchanged),
   * `[fileData]`, or `[disclosureText, fileData]` when a fixed policy
   * degraded the media — the disclosure must sit IMMEDIATELY before its
   * media part (decision D8) so converters can move the pair together. */
  const convertPart = async (part: Part): Promise<Part[]> => {
    const inline = part.inlineData;
    if (!inline?.data || !inline.mimeType) return [part];
    const top = inline.mimeType.split('/')[0];
    if (top !== 'image' && top !== 'audio' && top !== 'video') return [part];

    // Sniff the decoded bytes before touching disk — non-media or
    // unsupported containers stay inline untouched. The SNIFFED modality
    // is the authoritative gate: a part declared audio/* whose bytes are
    // actually a video container must not slip past a video-disabled
    // config on the strength of its declared MIME type.
    const bytes = Buffer.from(inline.data, 'base64');
    const sniffed = sniffMediaType(bytes.subarray(0, 4096));
    if (!sniffed) return [part];
    if (!modalities[sniffed.modality]) return [part];
    if (uploadsRemaining <= 0 || bytes.length > uploadBytesRemaining) {
      debugLogger.debug(
        `tool-result media budget exhausted; keeping part inline (${bytes.length} bytes)`,
      );
      return [part];
    }

    // Everything from staging-dir setup onward sits inside the try: mkdir
    // itself can fail (ENOSPC, EACCES on ~/.qwen, ~/.qwen/omni existing as a
    // regular file → ENOTDIR), and the contract is that failure of any single
    // part leaves THAT part inline — not that the whole tool result rejects,
    // which would report a tool that succeeded as failed.
    const store = new OmniObjectStore(config.storage.getQwenDir());
    let tempPath: string | undefined;
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
      const displayName = inline.displayName ?? `tool-media.${top}`;
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
        return [
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
      return [part];
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
