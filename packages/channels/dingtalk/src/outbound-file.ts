import { basename, extname } from 'node:path';
import { readValidatedLocalFile } from './outbound-local-file.js';
import {
  dropUnbalancedGapPrefix,
  findOutboundMediaMarkers,
  markerResidueDepth,
  neutralizeMediaMarkerOpenings,
  replaceOutboundMediaMarkers,
  stripPartialOutboundMediaMarker,
  type OutboundMediaMarker,
} from './outbound-markers.js';
import { uploadDingTalkMedia } from './outbound-media.js';
import { sanitizeStreamingImageMarkers } from './outbound-image.js';

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
  return neutralizeMediaMarkerOpenings(sanitized, 'FILE');
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
 * mirrors the file fixed point's.
 *
 * R8-3: on exhaustion the LAST transform is the image pass, and its removals
 * can splice the surroundings into a fresh complete `[FILE: …]` marker no
 * file pass ever sees — the inner fixed point fails closed on ITS exhaustion,
 * the outer must too. Run one more budgeted file sweep over the exhausted
 * text before returning it.
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
  return sanitizeFileMarkersToFixedPoint(sanitized);
}

/**
 * Whether an aligned marker starts outside its own line's residue: no
 * unclosed marker-shaped opening sits between the line start and the marker.
 * The same-line window is the precise discriminator for "inside a genuine
 * residue span" — a residue extent covers its opening's own line, and the
 * continuation rules never cover a LATER line that carries brackets, which a
 * complete marker always does. Counting openings over the whole prefix
 * reaches too far: an obligation whose residue stopped at an earlier line
 * end still de-protected markers on later lines (R24-2), losing a
 * deliverable marker the line-disciplined residue would have kept.
 */
function outsideResidueLine(
  text: string,
  marker: OutboundMediaMarker,
): boolean {
  const lineStart =
    Math.max(
      text.lastIndexOf('\n', marker.start - 1),
      text.lastIndexOf('\r', marker.start - 1),
    ) + 1;
  return markerResidueDepth(text, lineStart, marker.start) === 0;
}

/**
 * The markers of `markerName` in `text` that align — by path, in order —
 * with the `expected` list locked at the pipeline's entry.
 *
 * R22-5: the match is subsequence-tolerant. Strict positional matching
 * advanced the cursor only on a hit, so an expected entry removed by the
 * OTHER kind's fail-closed residue sweep never got consumed — every later
 * legitimate same-kind marker then failed alignment, landed in gap
 * sanitization, and was destroyed instead of delivered. A mismatch now
 * searches `expected` forward from the cursor, so a span-removed entry
 * desyncs only itself. Markers past the exhausted list or absent from it
 * stay unaligned: they are splice artifacts a removal minted, or a surplus
 * past the entry list, and the gap sanitizer removes them.
 */
function alignMarkers(
  text: string,
  markerName: 'IMAGE' | 'FILE',
  expected: readonly string[],
): OutboundMediaMarker[] {
  const markers = findOutboundMediaMarkers(text, markerName);
  const kept: OutboundMediaMarker[] = [];
  let matched = 0;
  for (const marker of markers) {
    if (matched >= expected.length) break;
    const alignedAt =
      marker.path === expected[matched]
        ? matched
        : expected.indexOf(marker.path, matched);
    if (alignedAt === -1) continue;
    kept.push(marker);
    matched = alignedAt + 1;
  }
  return kept;
}

/**
 * One residue pass over the gaps between the markers of `markerName` that
 * {@link alignMarkers} keeps, plus any `protectedSpans` — markers of the
 * OTHER kind the joint composition has already decided to keep. Unaligned
 * markers stay in their gap, where the gap sanitizer removes them along
 * with the residue; a gap sanitizer never touches a kept or protected span.
 *
 * R23-1: protection is what bounds the gap residue by BOTH kinds. A gap
 * bounded only by one kind's kept markers lets an ill-formed opening of
 * that kind run its same-line residue extent straight through a kept
 * marker of the other kind — deleting an aligned deliverable and violating
 * this function's own invariant. Splitting every gap around the protected
 * spans makes the residue stop at the cross-kind kept marker instead of
 * eating to end-of-line.
 */
function stripAlignedMarkers(
  text: string,
  markerName: 'IMAGE' | 'FILE',
  expected: readonly string[],
  protectedSpans: readonly OutboundMediaMarker[] = [],
): string {
  // Kept spans of this kind and protected spans of the other are disjoint —
  // marker spans of either kind cannot nest inside one another — so one
  // sorted island list bounds every gap.
  const islands = [
    ...alignMarkers(text, markerName, expected),
    ...protectedSpans,
  ].sort((a, b) => a.start - b.start);
  // R19-x (R6-3 closure): the gap residue strip is balance-aware. The depth
  // counts the ORIGINAL text before the gap — an ill-formed outer opening
  // keeps its balance obligation even after its own residue is stripped, so
  // the gap after a delivered inner marker loses the outer's bracket-less
  // path fragment instead of shipping it.
  //
  // R24-1: the obligation counts MARKER-SHAPED openings only. A prose `[`
  // is residue to no layer, yet raw bracket counting gave it a balance
  // obligation that deleted legitimate prose — up to the entire remainder
  // of the message after the last kept marker — whenever an unclosed prose
  // bracket preceded a deliverable marker.
  const sanitizeGap = (gap: string, depth: number): string => {
    const remainder = dropUnbalancedGapPrefix(gap, depth);
    return markerName === 'FILE'
      ? sanitizeFileMarkersToFixedPoint(remainder)
      : sanitizeStreamingImageMarkers(remainder);
  };
  let sanitized = '';
  let previousEnd = 0;
  for (const island of islands) {
    sanitized += sanitizeGap(
      text.slice(previousEnd, island.start),
      markerResidueDepth(text, 0, previousEnd),
    );
    sanitized += text.slice(island.start, island.end);
    previousEnd = island.end;
  }
  return (
    sanitized +
    sanitizeGap(
      text.slice(previousEnd),
      markerResidueDepth(text, 0, previousEnd),
    )
  );
}

/**
 * R16-5: strip FILE residue off the MODEL text, before images bake. Residue
 * stripping extends an ill-formed `[FILE:` opening to END OF LINE; run over
 * baked text it deletes an already-uploaded image's `![image](mediaId)`
 * markdown sharing the line — quota billed, never rendered, no receipt or
 * notice. Confined to the gaps between deliverable markers exactly like the
 * R9-3 receipt pass, so a residue line that also carries a deliverable
 * marker keeps it; an image marker inside a genuine residue span simply
 * shares the span's fail-closed removal and is never uploaded.
 *
 * R19-x (R6-3 closure): iterate to a fixed point and reconcile against the
 * marker list found at entry. A single pass's removal splices the
 * surroundings across the deleted span — `[FIL[FILE:\n/x]E: /ws/secret.pdf]`
 * becomes the deliverable marker `[FILE: /ws/secret.pdf]`, one the model
 * never emitted, which a single pass then handed to the uploader. Each pass
 * only deletes, so the loop terminates on its own.
 */
export function stripPartialFileMarkerBeforeBake(text: string): string {
  return stripAlignedMarkers(
    text,
    'FILE',
    findFileMarkers(text).map((marker) => marker.path),
  );
}

/**
 * R19-x (R6-3 closure): the JOINT pre-bake strip — the R16-5 treatment for
 * BOTH marker kinds with both expected lists locked at the entry text. A
 * FILE removal can splice its surroundings into an IMAGE marker the model
 * never emitted (`[IMAG[FILE:\n/x]E: /ws/chart.png]` →
 * `[IMAGE: /ws/chart.png]`), which an IMAGE pass run afterwards would
 * reconcile against its OWN input and upload; locking both lists at the
 * entry makes the artifact fail alignment and get removed instead. The
 * IMAGE mirror of the residue hazard itself — an ill-formed `[IMAGE: …`
 * sharing a line with a baked receipt eats it after the bake, billing the
 * upload while the text claims the image is still pending — closes here
 * too: IMAGE residue is stripped before any bake as well.
 */
export function stripPartialMediaMarkersBeforeBake(text: string): string {
  const expectedFile = findFileMarkers(text).map((marker) => marker.path);
  const expectedImage = findOutboundMediaMarkers(text, 'IMAGE').map(
    (marker) => marker.path,
  );
  let current = text;
  for (let pass = 0; pass < FILE_FIXED_POINT_PASS_BUDGET; pass++) {
    // R23-1: the FILE sweep's residue must stop at an IMAGE marker the
    // entry alignment keeps — otherwise an ill-formed `[FILE:` whose line
    // balances before a kept IMAGE marker eats it to end-of-line. Only a
    // span outside its own line's residue qualifies: one still inside an
    // unclosed opening sits within a genuine residue span and shares its
    // fail-closed removal (the R16-5 pin). R24-1: prose brackets are not
    // residue openings and must not de-protect a kept marker.
    const protectedImages = alignMarkers(
      current,
      'IMAGE',
      expectedImage,
    ).filter((marker) => outsideResidueLine(current, marker));
    const afterFile = stripAlignedMarkers(
      current,
      'FILE',
      expectedFile,
      protectedImages,
    );
    // R22-5/R23-1: the IMAGE sweep must never eat a FILE marker the FILE
    // sweep's alignment kept. Re-align against the FILE sweep's OUTPUT: the
    // spans that survive it are exactly the kept ones — a splice artifact
    // the sweep minted fails the entry-locked alignment and stays residue.
    // R24-2: the SAME residue-line qualification the IMAGE protection
    // applies — without it a complete FILE marker nested inside an unclosed
    // `[IMAGE:` opening survived the strip and was delivered, while the
    // forward twin removed its nested IMAGE marker: a fail-open asymmetry
    // in the fail-closed sanitizer.
    const protectedFiles = alignMarkers(afterFile, 'FILE', expectedFile).filter(
      (marker) => outsideResidueLine(afterFile, marker),
    );
    const next = stripAlignedMarkers(
      afterFile,
      'IMAGE',
      expectedImage,
      protectedFiles,
    );
    if (next === current) return next;
    current = next;
  }
  return neutralizeMediaMarkerOpenings(
    neutralizeMediaMarkerOpenings(current, 'FILE'),
    'IMAGE',
  );
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
