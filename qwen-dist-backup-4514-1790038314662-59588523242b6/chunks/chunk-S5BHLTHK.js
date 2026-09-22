// Force strict mode and setup for ESM
"use strict";
import {
  probeMediaMetadata
} from "./chunk-KSEKRQJO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/recognition.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
function bmffBrandType(brand) {
  if (brand.startsWith("qt")) {
    return { mimeType: "video/quicktime", modality: "video" };
  }
  if (brand.startsWith("M4A") || brand.startsWith("M4B")) {
    return { mimeType: "audio/mp4", modality: "audio" };
  }
  return { mimeType: "video/mp4", modality: "video" };
}
__name(bmffBrandType, "bmffBrandType");
function sniffMediaType(header) {
  if (header.length >= 12) {
    if (header.subarray(4, 8).toString("latin1") === "ftyp") {
      return bmffBrandType(header.subarray(8, 12).toString("latin1"));
    }
    const riff = header.subarray(0, 4).toString("latin1") === "RIFF";
    if (riff) {
      const kind = header.subarray(8, 12).toString("latin1");
      if (kind === "AVI ") {
        return { mimeType: "video/x-msvideo", modality: "video" };
      }
      if (kind === "WAVE") {
        return { mimeType: "audio/wav", modality: "audio" };
      }
      if (kind === "WEBP") {
        return { mimeType: "image/webp", modality: "image" };
      }
      return null;
    }
  }
  if (header.length >= 8) {
    if (header.readUInt32BE(0) === 2303741511) {
      return { mimeType: "image/png", modality: "image" };
    }
  }
  if (header.length >= 6) {
    const gifSig = header.subarray(0, 6).toString("latin1");
    if (gifSig === "GIF87a" || gifSig === "GIF89a") {
      return { mimeType: "image/gif", modality: "image" };
    }
  }
  if (header.length >= 4) {
    if (header.readUInt32BE(0) === 440786851) {
      return { mimeType: "video/webm", modality: "video" };
    }
    if (header.subarray(0, 4).toString("latin1") === "fLaC") {
      return { mimeType: "audio/flac", modality: "audio" };
    }
    if (header.subarray(0, 4).toString("latin1") === "OggS") {
      return { mimeType: "audio/ogg", modality: "audio" };
    }
  }
  if (header.length >= 3) {
    if (header[0] === 255 && header[1] === 216 && header[2] === 255) {
      return { mimeType: "image/jpeg", modality: "image" };
    }
    if (header.subarray(0, 3).toString("latin1") === "ID3") {
      return { mimeType: "audio/mpeg", modality: "audio" };
    }
    if (header[0] === 255 && header[1] !== 254 && (header[1] & 224) === 224) {
      if ((header[1] & 6) === 0) {
        return { mimeType: "audio/aac", modality: "audio" };
      }
      return { mimeType: "audio/mpeg", modality: "audio" };
    }
  }
  return null;
}
__name(sniffMediaType, "sniffMediaType");
function sniffVideoMimeType(header) {
  const sniffed = sniffMediaType(header);
  return sniffed?.modality === "video" ? sniffed.mimeType : null;
}
__name(sniffVideoMimeType, "sniffVideoMimeType");
function extensionForMime(mimeType) {
  const sniffTable = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-msvideo": ".avi",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/aac": ".aac",
    "audio/wav": ".wav",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    // Non-media policy artifacts (transcripts) promoted into objects/.
    "text/plain": ".txt"
  };
  return sniffTable[mimeType] ?? ".bin";
}
__name(extensionForMime, "extensionForMime");
async function hashFileSha256(filePath, signal) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath, signal ? { signal } : {}), hash);
  return hash.digest("hex");
}
__name(hashFileSha256, "hashFileSha256");
var SNIFF_BYTES = 4096;
async function sniffFileModality(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    await handle.read(buf, 0, buf.length, 0);
    return sniffMediaType(buf)?.modality ?? null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {
    });
  }
}
__name(sniffFileModality, "sniffFileModality");
async function recognizeMediaFile(filePath, options) {
  const { expectedModality, signal } = options ?? {};
  const handle = await fs.open(filePath, "r");
  let header;
  let sizeBytes;
  try {
    const stat = await handle.stat();
    sizeBytes = stat.size;
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    await handle.read(buf, 0, buf.length, 0);
    header = buf;
  } finally {
    await handle.close();
  }
  const sniffed = sniffMediaType(header);
  if (!sniffed) {
    throw new Error(
      `File content does not match a supported media container: ${path.basename(filePath)}`
    );
  }
  if (expectedModality && sniffed.modality !== expectedModality) {
    throw new Error(
      `File content sniffs as ${sniffed.modality} (${sniffed.mimeType}) but was referenced as ${expectedModality}: ${path.basename(filePath)}`
    );
  }
  const metadata = await probeMediaMetadata(filePath, sniffed.modality, signal);
  return {
    modality: sniffed.modality,
    detectedMimeType: sniffed.mimeType,
    sizeBytes,
    metadata
  };
}
__name(recognizeMediaFile, "recognizeMediaFile");

export {
  sniffMediaType,
  sniffVideoMimeType,
  extensionForMime,
  hashFileSha256,
  sniffFileModality,
  recognizeMediaFile
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
