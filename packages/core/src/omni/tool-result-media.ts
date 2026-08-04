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
import { isOmniDeliveryActive, processMediaForOmniDelivery } from './index.js';
import { OmniObjectStore } from './storage.js';
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
 *   silently violates the size contract; the failure is logged);
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

  const convertPart = async (part: Part): Promise<Part> => {
    const inline = part.inlineData;
    if (!inline?.data || !inline.mimeType) return part;
    const top = inline.mimeType.split('/')[0];
    if (top !== 'image' && top !== 'audio' && top !== 'video') return part;

    // Sniff the decoded bytes before touching disk — non-media or
    // unsupported containers stay inline untouched. The SNIFFED modality
    // is the authoritative gate: a part declared audio/* whose bytes are
    // actually a video container must not slip past a video-disabled
    // config on the strength of its declared MIME type.
    const bytes = Buffer.from(inline.data, 'base64');
    const sniffed = sniffMediaType(bytes.subarray(0, 4096));
    if (!sniffed) return part;
    if (!modalities[sniffed.modality]) return part;
    if (uploadsRemaining <= 0 || bytes.length > uploadBytesRemaining) {
      debugLogger.debug(
        `tool-result media budget exhausted; keeping part inline (${bytes.length} bytes)`,
      );
      return part;
    }

    const store = new OmniObjectStore(config.storage.getQwenDir());
    const stagingDir = path.join(store.getOmniRootDir(), 'downloads');
    await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(
      stagingDir,
      `${randomBytes(8).toString('hex')}.part`,
    );
    try {
      await fs.writeFile(tempPath, bytes, { mode: 0o600 });
      const delivery = await processMediaForOmniDelivery(tempPath, config, {
        expectedModality: sniffed.modality,
        signal,
      });
      changed = true;
      uploadsRemaining--;
      uploadBytesRemaining -= bytes.length;
      return {
        fileData: {
          fileUri: delivery.fileUri,
          mimeType: delivery.mimeType,
          displayName: inline.displayName ?? `tool-media.${top}`,
        },
      };
    } catch (err) {
      if (signal.aborted) throw err;
      debugLogger.debug(
        `tool-result media upload failed, keeping inline: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return part;
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
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
        if (converted !== nestedPart) nestedChanged = true;
        convertedNested.push(converted);
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
    result.push(await convertPart(part));
  }

  return changed ? result : responseParts;
}
