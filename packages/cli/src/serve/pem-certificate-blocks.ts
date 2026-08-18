/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { X509Certificate } from 'node:crypto';

/**
 * A PEM certificate block with every marker alone on its own line. Node's
 * certificate loader is line-strict AND all-or-nothing: one fused
 * `-----END CERTIFICATE----------BEGIN CERTIFICATE-----` (what
 * `cat a.pem b.pem` produces when `a.pem` has no trailing newline) makes it
 * discard the WHOLE bundle with `bad end line` — including any cert appended
 * after it, so the workers lose the trust the merge exists to give them.
 * `tls.createSecureContext({ ca })` does not throw on that shape, so it cannot
 * stand in as the validator. Base64 never contains `-`, so the body match
 * cannot run past its own end marker or backtrack.
 */
const STRICT_PEM_CERTIFICATE_BLOCK =
  /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----$/gm;

/**
 * Everything Node's certificate loader tolerates that the line-anchored match
 * above does not: a UTF-8 BOM before the first block (what Windows tooling
 * writes), CRLF terminators, trailing whitespace after a marker line, and
 * leading whitespace on body lines. Measured on Node 22 through a real
 * `NODE_EXTRA_CA_CERTS` handshake: all four shapes load and verify. Matching
 * them verbatim would drop an operator CA the loader would have accepted, and
 * blame the file for holding no loadable block.
 */
function normalizeForCertificateMatch(contents: string): string {
  return contents
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
}

/**
 * The certificate blocks of `contents`, or `undefined` when Node's loader
 * would reject the file: no block at all, a `BEGIN CERTIFICATE` marker that
 * did not yield a well-formed block, or a block whose body does not decode.
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
  const normalized = normalizeForCertificateMatch(contents);
  const blocks = normalized.match(STRICT_PEM_CERTIFICATE_BLOCK) ?? [];
  const markers = normalized.match(/-----BEGIN CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0 || blocks.length !== markers.length) return undefined;
  // Shape is not loadability. A body made only of base64 *characters* still
  // matches above while failing to decode (one misplaced `=` in a truncated or
  // hand-edited cert), and Node's loader is all-or-nothing on that too: it
  // discards the WHOLE bundle with `bad base64 decode`, taking the cert
  // appended after it down with it — the very failure the marker check exists
  // to prevent, through a sibling entrance. `X509Certificate` is the loader's
  // own parser, so let it decide. Measured on Node 22: a corrupted block plus a
  // good daemon cert leaves the worker trusting neither.
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      return undefined;
    }
  }
  return blocks;
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
