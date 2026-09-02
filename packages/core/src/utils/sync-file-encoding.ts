/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  iconvDecode,
  iconvEncode,
  iconvEncodingExists,
} from './iconvHelper.js';
import {
  bomEncodingToName,
  decodeBOMBuffer,
  detectBOM,
  isValidUtf8,
  type FileReadResult,
} from './fileUtils.js';
import {
  prepareTextFileContent,
  type ReadTextFileResponse,
} from '../services/fileSystemService.js';
import { detectEncodingFromBuffer } from './systemEncoding.js';
import { isUtf8CompatibleEncoding } from './encoding.js';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('SYNC_FILE_ENCODING');

export function decodeBufferWithEncodingInfo(full: Buffer): FileReadResult {
  if (full.length === 0) {
    return { content: '', encoding: 'utf-8', bom: false };
  }

  const bomInfo = detectBOM(full);
  if (bomInfo) {
    return {
      content: decodeBOMBuffer(full, bomInfo),
      encoding: bomEncodingToName(bomInfo.encoding),
      bom: true,
    };
  }

  if (isValidUtf8(full)) {
    return { content: full.toString('utf8'), encoding: 'utf-8', bom: false };
  }

  const detected = detectEncodingFromBuffer(full);
  if (detected && !isUtf8CompatibleEncoding(detected)) {
    try {
      if (iconvEncodingExists(detected)) {
        return {
          content: iconvDecode(full, detected),
          encoding: detected,
          bom: false,
        };
      }
    } catch (error) {
      debugLogger.warn(
        `Failed to decode buffer as ${detected}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { content: full.toString('utf8'), encoding: 'utf-8', bom: false };
}

export function encodeTextFileContent(
  filePath: string,
  content: string,
  meta?: ReadTextFileResponse['_meta'] | null,
): Buffer {
  const prepared = prepareTextFileContent(filePath, content, meta, {
    decode: iconvDecode,
    encode: iconvEncode,
    encodingExists: iconvEncodingExists,
  });
  if (!prepared) {
    throw new Error('iconv-lite did not prepare non-UTF-8 text content');
  }
  if (Buffer.isBuffer(prepared.data)) return prepared.data;
  return Buffer.from(prepared.data, prepared.encoding ?? 'utf-8');
}
