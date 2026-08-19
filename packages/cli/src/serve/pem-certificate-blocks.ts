/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { X509Certificate } from 'node:crypto';

/** `-----BEGIN <label>-----` / `-----END <label>-----` framing. */
const BEGIN_PREFIX = '-----BEGIN ';
const END_PREFIX = '-----END ';
const MARKER_SUFFIX = '-----';
const CERTIFICATE_LABEL = 'CERTIFICATE';
/** Canonical PEM wraps the body at 64 columns; so does every producer. */
const PEM_BODY_COLUMNS = 64;

/**
 * The label of a `-----BEGIN X-----`/`-----END X-----` line, or `undefined`
 * when the line is not one.
 *
 * OpenSSL's PEM reader — the parser behind `NODE_EXTRA_CA_CERTS` — matches
 * these markers at the START of a line and requires the trailing `-----`, so
 * `# see -----BEGIN CERTIFICATE----- below` is prose it walks straight past.
 * Counting markers as unanchored substrings (what this module did before) saw
 * that line as a block that failed to parse and rejected the whole file.
 *
 * A label containing `-` is never a real one: it is the fused
 * `-----END CERTIFICATE----------BEGIN CERTIFICATE-----` that `cat a.pem
 * b.pem` produces when `a.pem` has no trailing newline, and OpenSSL rejects it
 * with `bad end line`.
 */
function pemMarkerLabel(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix) || !line.endsWith(MARKER_SUFFIX)) {
    return undefined;
  }
  const label = line.slice(prefix.length, line.length - MARKER_SUFFIX.length);
  return label.length > 0 && !label.includes('-') ? label : undefined;
}

/**
 * Everything OpenSSL's line reader tolerates that a verbatim match does not: a
 * UTF-8 BOM at the start of ANY line (Windows tooling writes one, and
 * concatenating operator files puts one mid-file, in front of a later block —
 * a file-start-anchored strip left that block unmatched and lost it), CRLF
 * terminators, and leading/trailing whitespace on marker and body lines
 * alike. Measured on Node 22 through real
 * `NODE_EXTRA_CA_CERTS` handshakes: every one of those shapes loads and
 * verifies, so rejecting any of them drops an operator CA the workers would
 * have trusted and blames a file that was never the problem.
 */
function normalizePemLine(line: string): string {
  return line.replace(/^\uFEFF/, '').replace(/^[ \t\r]+|[ \t\r]+$/g, '');
}

/**
 * The certificate blocks a worker's `NODE_EXTRA_CA_CERTS` loader would take
 * from `contents`, in file order, or `undefined` when it would take none.
 *
 * This walks the file the way OpenSSL's `PEM_read_bio_X509` loop does rather
 * than pattern-matching what a well-formed file looks like. Three rounds of
 * review found three more shapes the pattern-matching version rejected and the
 * loader accepts (embedded marker text, whitespace inside a base64 body line,
 * a mid-file BOM); the shape-by-shape surface is unbounded, so the framing
 * decisions themselves are the loader's here.
 *
 * The loader is PREFIX-loading, not all-or-nothing (measured on Node 22:
 * a good root followed by a fused block still handshakes `authorized=true`
 * while Node prints `Ignoring extra certs … bad end line`): it keeps every
 * certificate up to the first malformed block and loses that block and
 * everything after it. So do we — dropping the good prefix too would discard
 * anchors the workers would otherwise have.
 *
 * Only certificate blocks come back. A combined cert+key serving PEM passes
 * boot validation (which parses the first block alone), and copying its
 * private key into a tmpdir bundle `NODE_EXTRA_CA_CERTS` never reads would
 * leave key material behind a SIGKILLed daemon, where the `exit` cleanup
 * cannot run.
 *
 * Both the spawn-time merge (`resolveWorkerCaCertPath`) and the boot-time
 * trust-gap diagnostic (`describeWorkerTlsTrustGaps`) go through here. Judging
 * the same file with two different parsers is what let a fused or DER operator
 * bundle be counted as an anchor at boot while the merge discarded it — the
 * daemon log stayed clean while every worker handshake failed.
 */
export function extractCertificateBlocks(
  contents: string,
): string[] | undefined {
  const lines = contents.split('\n').map(normalizePemLine);
  const blocks: string[] = [];
  let index = 0;
  scan: while (index < lines.length) {
    const label = pemMarkerLabel(lines[index]!, BEGIN_PREFIX);
    if (label === undefined) {
      index += 1;
      continue;
    }
    const body: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      if (line.startsWith(END_PREFIX)) {
        // A mismatched or fused end line is `bad end line`: the loader stops
        // reading the file here and keeps only what it already has.
        if (pemMarkerLabel(line, END_PREFIX) !== label) break scan;
        break;
      }
      body.push(line);
    }
    // Ran off the end without an end line — same `bad end line` stop.
    if (cursor >= lines.length) break;
    if (label === CERTIFICATE_LABEL) {
      // Interior whitespace in a body line is skipped by the decoder, not an
      // error, so join first and judge the alphabet afterwards.
      const encoded = body.join('').replace(/\s/g, '');
      // Outside the base64 alphabet is `bad base64 decode`, another stop.
      if (encoded.length === 0 || /[^A-Za-z0-9+/=]/.test(encoded)) break;
      const block = renderCertificateBlock(encoded);
      try {
        // Shape is not loadability: a body made only of base64 *characters*
        // still frames correctly while failing to decode (one misplaced `=` in
        // a truncated or hand-edited cert). `X509Certificate` is the loader's
        // own parser, so let it decide, and stop where the loader stops.
        new X509Certificate(block);
      } catch {
        break;
      }
      blocks.push(block);
    }
    index = cursor + 1;
  }
  return blocks.length > 0 ? blocks : undefined;
}

/** Canonical PEM for `encoded`, so a merged bundle is byte-stable. */
function renderCertificateBlock(encoded: string): string {
  const wrapped: string[] = [];
  for (let at = 0; at < encoded.length; at += PEM_BODY_COLUMNS) {
    wrapped.push(encoded.slice(at, at + PEM_BODY_COLUMNS));
  }
  return [
    `${BEGIN_PREFIX}${CERTIFICATE_LABEL}${MARKER_SUFFIX}`,
    ...wrapped,
    `${END_PREFIX}${CERTIFICATE_LABEL}${MARKER_SUFFIX}`,
  ].join('\n');
}

/**
 * The certificates a worker's loader would actually take from `contents`, or
 * `undefined` when it would take none of them.
 */
export function loadableCertificates(
  contents: string,
): X509Certificate[] | undefined {
  const blocks = extractCertificateBlocks(contents);
  if (!blocks) return undefined;
  // `extractCertificateBlocks` already parsed each block, so this cannot throw.
  return blocks.map((block) => new X509Certificate(block));
}
