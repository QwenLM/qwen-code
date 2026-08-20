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
 * absolute path — the exact display this function exists to prevent.
 *
 * R3-11: bound the total work, not just termination. Self-similar nesting
 * unwinds one level per pass, so an adversarial depth pays a full re-scan of
 * the whole text per level — seconds of synchronous CPU at CONTENT_LIMIT,
 * re-paid on every streaming card flush, freezing every session the adapter
 * process serves. After a small pass budget the sweep therefore fails CLOSED
 * instead of continuing: one cheap left-to-right pass cuts every remaining
 * FILE-shaped opening to the end of its own line — the same extent the
 * stripper already takes for ill-formed openings — so a budget-exhausting
 * input loses its marker-shaped residue, never its no-leak guarantee.
 *
 * Run this BEFORE any image sanitisation. The image pass substitutes a
 * bracketed `[Image pending]` placeholder, and a file pass run afterwards
 * would treat that synthetic `]` as the close of an unclosed `[FILE:` and
 * swallow it.
 */
const FILE_FIXED_POINT_PASS_BUDGET = 8;

export function sanitizeFileMarkersToFixedPoint(text: string): string {
  let sanitized = text;
  for (let pass = 0; pass < FILE_FIXED_POINT_PASS_BUDGET; pass++) {
    const next = sanitizeStreamingFileMarkers(sanitized);
    if (next === sanitized) return sanitized;
    sanitized = next;
  }
  return neutralizeFileMarkerOpenings(sanitized);
}

/**
 * Whether the `[` at `open` opens a FILE-shaped residue, confined to the
 * line ending at `lineEnd`: the full name immediately after the bracket or
 * after horizontal spaces, folded through `toUpperCase` exactly as the
 * recognition gates do (R6-2) — an `iu` regex is not a substitute.
 */
function opensFileMarkerName(
  text: string,
  open: number,
  lineEnd: number,
): boolean {
  let index = open + 1;
  while (index < lineEnd && /[^\S\r\n]/u.test(text[index]!)) index++;
  let upper = '';
  while (index < lineEnd && upper.length < 'FILE:'.length) {
    upper += text[index]!.toUpperCase();
    index++;
  }
  return upper === 'FILE:';
}

/**
 * Cut every line at its first FILE-shaped opening. A removal can only create
 * a new marker across the boundary it made, which the budgeted loop above has
 * already failed to settle, so the residue is cut where it stands. Lines the
 * sweep does not touch survive byte-for-byte — including code quotes — this
 * runs only when the budget is exhausted.
 */
function neutralizeFileMarkerOpenings(text: string): string {
  let result = '';
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    let cut = -1;
    for (let index = lineStart; index < lineEnd; index++) {
      if (text[index] === '[' && opensFileMarkerName(text, index, lineEnd)) {
        cut = index;
        break;
      }
    }
    result += text.slice(lineStart, cut === -1 ? lineEnd : cut);
    if (newline === -1) break;
    result += '\n';
    lineStart = newline + 1;
  }
  return result;
}

/**
 * R3-2: FILE-to-a-fixed-point and then ONE image pass is not a fixed point
 * of the JOINT composition — the image pass removes residue spans, and a
 * removal splices its surroundings into a `[FILE: …]` marker the file pass
 * already finished with (`[FIL` + `[IMAGE: …]` + `E: /etc/passwd]` becomes
 * `[FILE: /etc/passwd]`), which then shipped through every display surface.
 * Iterate the two passes until stable. Each changed iteration removes at
 * least one marker opening, and the `[Image pending]` token a replacement
 * inserts never re-opens one, so the loop terminates on its own; the budget
 * mirrors the file fixed point's, leaving the text at least as sanitized as
 * the last completed pass on exhaustion.
 */
export function sanitizeMediaMarkersToStable(
  text: string,
  imagePass: (text: string) => string,
): string {
  let sanitized = text;
  for (let pass = 0; pass < FILE_FIXED_POINT_PASS_BUDGET; pass++) {
    const next = imagePass(sanitizeFileMarkersToFixedPoint(sanitized));
    if (next === sanitized) return next;
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
