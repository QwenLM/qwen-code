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
/**
 * OpenSSL also accepts the legacy `PEM_STRING_X509_OLD` label for
 * certificates (measured on Node v22.23.2: a pure-legacy file authorizes
 * through NODE_EXTRA_CA_CERTS), so rejecting it drops an operator CA the
 * workers would have trusted — while warning that the file holds "no PEM
 * certificate block Node can load", which it does.
 */
const LEGACY_CERTIFICATE_LABEL = 'X509 CERTIFICATE';
/** Canonical PEM wraps the body at 64 columns; so does every producer. */
const PEM_BODY_COLUMNS = 64;
/**
 * A `Name: value` RFC 1421 header line. A base64 body line can never
 * contain `:`, so inside a block this cannot eat a body line.
 */
const RFC1421_HEADER_LINE = /^[A-Za-z0-9-]+:.+$/;
/**
 * The UTF-8 byte order mark. The loader strips it only from the FIRST line
 * each of its `PEM_read_bio_X509` scans reads — the file start, and the line
 * immediately following a consumed block's END marker (measured on Node
 * v22.23.2: a BOM'd BEGIN in either position loads; the SAME line preceded
 * by a blank line, a prose line or nothing at all does not — the scan just
 * walks past it and keeps whatever prefix it already has, with no warning).
 * `extractCertificateBlocks` applies it at exactly those positions.
 */
const UTF8_BOM = '\uFEFF';

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
 * Everything OpenSSL's line reader tolerates that a verbatim match does not:
 * CRLF terminators and trailing whitespace. Measured on Node 22 through real
 * `NODE_EXTRA_CA_CERTS` handshakes: both shapes load and verify, so rejecting
 * them drops an operator CA the workers would have trusted and blames a file
 * that was never the problem.
 *
 * A UTF-8 BOM is NOT stripped here (R2-21 entrance B1): the loader removes
 * one only from the first line each of its scans reads (see `UTF8_BOM`), and
 * anywhere else it hides the marker — measured on Node v22.23.2, a serving
 * file of leaf + blank line + BOM-prefixed issuing CA boots green and used
 * to diagnose zero gaps here while the loader took only the leaf, leaving
 * every worker restart-looping UNABLE_TO_VERIFY_LEAF_SIGNATURE. Stripping on
 * ANY line counted such a rescued block as an anchor the workers never got.
 *
 * LEADING whitespace is deliberately NOT stripped (R2-21 entrance P1). It is
 * the one shape in this family the loader does not tolerate on a marker line:
 * measured on Node v22.23.0 / OpenSSL 3.0.13, a file whose
 * `-----BEGIN/END CERTIFICATE-----` markers carry a leading space or tab loads
 * NOTHING — the handshake fails UNABLE_TO_VERIFY_LEAF_SIGNATURE with no
 * `Ignoring extra certs` warning, and `openssl storeutl -certs` reports 0 —
 * while the same file un-indented loads and verifies. Stripping it here made
 * this module count such a block as an anchor the workers never got. Body
 * lines are unaffected: their leading whitespace is dropped when the base64 is
 * joined below, which is what the decoder does too.
 */
function normalizePemLine(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) <= 0x20) end -= 1;
  return line.slice(0, end);
}

/**
 * The certificate blocks a worker's `NODE_EXTRA_CA_CERTS` loader would take
 * from `contents`, in file order, or `undefined` when it would take none.
 *
 * This walks the file the way OpenSSL's `PEM_read_bio_X509` loop does rather
 * than pattern-matching what a well-formed file looks like. Rounds of review
 * found shape after shape the pattern-matching version rejected and the
 * loader accepts (embedded marker text, whitespace inside a base64 body
 * line, a BOM on a scan's first line); the shape-by-shape surface is
 * unbounded, so the framing decisions themselves are the loader's here.
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
  // A BOM is stripped only from the first line each loader scan reads: the
  // file start, and the line immediately after a consumed block's END marker
  // (`UTF8_BOM`). Anywhere else it hides the marker, the scan walks past the
  // block, and the workers never receive it.
  let atScanStart = true;
  scan: while (index < lines.length) {
    let line = lines[index]!;
    if (atScanStart) {
      if (line.startsWith(UTF8_BOM)) line = line.slice(UTF8_BOM.length);
      atScanStart = false;
    }
    const label = pemMarkerLabel(line, BEGIN_PREFIX);
    if (label === undefined) {
      index += 1;
      continue;
    }
    const body: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const innerLine = lines[cursor]!;
      if (innerLine.startsWith(END_PREFIX)) {
        // A mismatched or fused end line is `bad end line`: the loader stops
        // reading the file here and keeps only what it already has.
        if (pemMarkerLabel(innerLine, END_PREFIX) !== label) break scan;
        break;
      }
      body.push(innerLine);
    }
    // Ran off the end without an end line — same `bad end line` stop.
    if (cursor >= lines.length) break;
    // RFC 1421 header lines — the `Proc-Type:`/`DEK-Info:` pair of legacy
    // encrypted keys — sit between the BEGIN marker and the first blank
    // line. The loader parses them, skips the block and CONTINUES — but only
    // when that blank separator is present (R2-21 entrance B2): without it
    // the block fails to load and the loader keeps nothing more from the
    // rest of the file (measured on Node v22.23.2: leaf + no-blank key block
    // + root hands the workers the leaf prefix alone, while the blank-line
    // twin authorizes). `break scan` stops where the loader stops.
    let bodyStart = 0;
    while (
      bodyStart < body.length &&
      RFC1421_HEADER_LINE.test(body[bodyStart]!)
    ) {
      bodyStart += 1;
    }
    if (bodyStart > 0) {
      if (body[bodyStart] !== '') break scan;
      bodyStart += 1;
      body.splice(0, bodyStart);
    }
    // Interior whitespace in a body line is skipped by the decoder, not an
    // error, so join first and judge the alphabet afterwards. OpenSSL decodes
    // every PEM block it walks, including blocks that are not certificates.
    // "Whitespace" is the decoder's ASCII set, NOT JS `\s`: `\s` also strips
    // a U+FEFF BOM, and a BOM'd body line is exactly what the decoder fails
    // on (`bad base64 decode`, measured — the loader keeps only the prefix).
    const encoded = [...body.join('')]
      .filter((char) => char.charCodeAt(0) > 0x20)
      .join('');
    if (!pemBodyDecodes(encoded)) {
      break;
    }
    if (label === CERTIFICATE_LABEL || label === LEGACY_CERTIFICATE_LABEL) {
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
    atScanStart = true;
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

/** The 6-bit value of a base64 character (alphabet already checked). */
function base64CharValue(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62; // '+'
  return 63; // '/'
}

/**
 * Whether `encoded` is a base64 body the loader's decoder consumes.
 *
 * The decoder ignores non-zero "unused" bits in the final group — measured
 * on Node v22.23.2 / OpenSSL 3.0.13: such a file loads and authorizes with
 * byte-identical decoded bytes — so a straight round-trip (re-encode the
 * decoded bytes and demand the input back) is too strict: it rejected those
 * bodies, stopping the scan and dropping every block after them. Compare
 * only the bits the decoder consumes: everything before the last character
 * exactly, the last character masked to its used bits (two with `==`
 * padding, four with `=`). Missing padding is fine too (measured the same
 * way: an unpadded body loads and authorizes).
 */
function pemBodyDecodes(encoded: string): boolean {
  if (encoded.length === 0 || /[^A-Za-z0-9+/=]/.test(encoded)) return false;
  const bare = encoded.replace(/=+$/, '');
  const padLength = encoded.length - bare.length;
  if (bare.length === 0 || padLength > 2) return false;
  const canonical = Buffer.from(bare, 'base64')
    .toString('base64')
    .replace(/=+$/, '');
  if (canonical.length !== bare.length) return false;
  if (padLength === 0) return canonical === bare;
  if (canonical.slice(0, -1) !== bare.slice(0, -1)) return false;
  const usedBits = padLength === 2 ? 0b110000 : 0b111100;
  return (
    (base64CharValue(bare.charCodeAt(bare.length - 1)) & usedBits) ===
    (base64CharValue(canonical.charCodeAt(canonical.length - 1)) & usedBits)
  );
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
