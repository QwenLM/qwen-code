import { basename, extname } from 'node:path';
import { readValidatedLocalFile } from './outbound-local-file.js';
import {
  findOutboundMediaMarkers,
  replaceOutboundMediaMarkers,
  stripPartialOutboundMediaMarker,
  type OutboundMediaMarker,
} from './outbound-markers.js';
import { uploadDingTalkMedia } from './outbound-media.js';

export const MAX_FILES_PER_RESPONSE = 5;

export type FileMarker = OutboundMediaMarker;

export interface ValidatedFile {
  data: Buffer;
  fileName: string;
  fileType: string;
  mimeType: string;
}

export function findFileMarkers(text: string): FileMarker[] {
  return findOutboundMediaMarkers(text, 'FILE');
}

export function replaceFileMarkers(
  text: string,
  markers: readonly FileMarker[],
  replacements: readonly string[],
): string {
  return replaceOutboundMediaMarkers(text, markers, replacements);
}

export function stripPartialFileMarker(text: string): string {
  return stripPartialOutboundMediaMarker(text, 'FILE', '');
}

export function sanitizeStreamingFileMarkers(text: string): string {
  const markers = findFileMarkers(text);
  return stripPartialFileMarker(
    replaceFileMarkers(
      text,
      markers,
      markers.map(() => ''),
    ),
  );
}

/**
 * Repeat {@link sanitizeStreamingFileMarkers} until it stops changing.
 *
 * File markers are removed rather than replaced, so a removal can splice its
 * surroundings into a marker that was not there before —
 * `[FI[FILE: /tmp/a]LE: /etc/passwd]` becomes `[FILE: /etc/passwd]` after one
 * pass. Each pass only deletes, so the text shrinks monotonically and the
 * loop terminates on its own — which is why it runs to a real fixed point.
 * R1-1: it used to stop after 8 passes, and since a pass unwinds only one
 * level of self-similar nesting, depth >= 9 returned text with a LIVE
 * `[FILE: …]` marker that both display consumers then rendered with the
 * absolute path — the exact display this function exists to prevent. The
 * monotone-shrink argument proves an uncapped loop halts; the cap was what
 * broke the contract. `text.length` is a sound bound: every iteration that
 * changes the text removes at least one character.
 *
 * Run this BEFORE any image sanitisation. The image pass substitutes a
 * bracketed `[Image pending]` placeholder, and a file pass run afterwards
 * would treat that synthetic `]` as the close of an unclosed `[FILE:` and
 * swallow it.
 */
export function sanitizeFileMarkersToFixedPoint(text: string): string {
  let sanitized = text;
  for (let pass = 0; pass <= text.length; pass++) {
    const next = sanitizeStreamingFileMarkers(sanitized);
    if (next === sanitized) break;
    sanitized = next;
  }
  return sanitized;
}

export function safeFileName(filePath: string): string {
  const sanitized = basename(filePath)
    // `\p{Cf}` covers the enumerated bidi overrides and isolates along with the
    // zero-width family (U+200B\u2013U+200D, U+2060, U+FEFF) the explicit list left
    // out \u2014 all of which can disguise an attachment's extension in the
    // recipient's file list.
    .replace(/[\p{Cc}\p{Cf}[\]]+/gu, '_')
    .slice(0, 255);
  // `slice` counts UTF-16 code units, so a cut landing between the halves of an
  // astral character emits a lone surrogate that is not valid UTF-8 to encode.
  const trimmed = /[\uD800-\uDBFF]$/u.test(sanitized)
    ? sanitized.slice(0, -1)
    : sanitized;
  return trimmed || 'file';
}

export function readValidatedFile(
  filePath: string,
  options: { workspaceDir: string; temporaryDir?: string },
): ValidatedFile {
  const file = readValidatedLocalFile(filePath, {
    ...options,
    label: 'File',
  });
  const fileName = safeFileName(file.fileName);
  const extension = extname(fileName).slice(1).toLowerCase();
  return {
    data: file.data,
    fileName,
    fileType: extension || 'file',
    mimeType: 'application/octet-stream',
  };
}

export function uploadDingTalkFile(
  file: ValidatedFile,
  accessToken: string,
): Promise<string> {
  return uploadDingTalkMedia(file, accessToken, 'file');
}
