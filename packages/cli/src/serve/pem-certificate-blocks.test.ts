/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractCertificateBlocks,
  loadableCertificates,
} from './pem-certificate-blocks.js';

/**
 * Every expectation in this file was taken from Node 22 / OpenSSL 3 itself:
 * each shape was written to a file, pointed at through `NODE_EXTRA_CA_CERTS`
 * in a child process, and a real `tls.connect` to a server holding the leaf
 * these certificates anchor recorded whether the loader had taken them. The
 * three rounds of divergence this module has been through all came from
 * asserting what a well-formed PEM file looks like instead; the loader is the
 * only oracle that settles it.
 */
const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUcAV/pClZmXJcMTUQ7OBXsMJfVBkwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNUHJvYmUgUm9vdCBDQTAeFw0yNjA4MTkwMjIxMzRaFw0z
NjA4MTYwMjIxMzRaMBgxFjAUBgNVBAMMDVByb2JlIFJvb3QgQ0EwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDICx6ZzCl3rP/Aa33Tqb8TbFOZ7ezouwe5
7kDXA1MRFEc+gRvMP5doHiJRnhYuB9uRP+1VNGd8og8wGIY1FBtYdL1iy5rdQIF9
i+I9URdt764y88h1W5p/iMlxNO/ZeMmmZwuG0cQtdTLfQpR8QoS9kfKWGW4qGEa6
+B/ZOHRusgw5eMvG/vc8+roSttzHzbtEXrAg8GWWcCV8KQWqvN1YylJGsLWW4JGl
jDy9Q9xhPtLtYnT6zr87J/MJbdfBp0bKVveXoW2+7Nc3Ujr3gEdXhT3laQL7fFdQ
N5jW+NmVgHg5UGUjkDlusSUS44WyXdAk1NhYJimoganOafnbK9jfAgMBAAGjUzBR
MB0GA1UdDgQWBBTiORNFioXP/sD/HQpXuCMC2JN6EzAfBgNVHSMEGDAWgBTiORNF
ioXP/sD/HQpXuCMC2JN6EzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQB2Q7ivxcFlavCpt0hA6SX8Crtdg4HZYza+nLRrSDGxC0R0/c1Ax0W/nSrQ
+Cjr61zpAzFOJ516RmIKJ4La2Hv4Nwiub1rZpEMc9GXaMmgC+8Vy0rkma/RuX2ML
TjgJrasVxcR/DRB4PRDWykhdgcfp5gdubPhi/9xr1SNWyX+idR9+iJs/y/DNc9Jt
OI0+q5IPhHyu7dpgEDrOelnfSufFLl+SmS9No/EhRs1RC5zH78qsNLI8ggACOIJx
bh/8x87z7BA8oKl0WlFMNWZqOBQ1lR7cSmlhHUtC/QmJm6YNU71wpUP5+WgZHvPo
XKg878D/pA1BJ8fgC9Mrczhl6PIJ
-----END CERTIFICATE-----
`;

const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIDJjCCAg6gAwIBAgIUNWSrcDrHDnBRI6jTNPSQCS9RJcQwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNUHJvYmUgUm9vdCBDQTAeFw0yNjA4MTkwMjIxMzRaFw0z
NjA4MTYwMjIxMzRaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBANJ7RJRMFrD94mIW4/OEJUSYs1feTLKMYWGfJzgb
GHlnEILhKcVnJA+DMHZ8gvfc13oOF0+OGN7RqLHx+SL7eG7AT03PS9z7Qj1tEIpS
BxHPLkIdha9fPwtL6Pvh2Pqfsm2aAOTXT4EaQjGkrVNXe5V1JxfOjoiYV+eWKFwt
d3ABd+piE9RoTZQf30guISSw2EEhQmcutaZx6w8m725tc6ZYl8jIz3yNmgtcgFfB
5CUPmowQYFfdIxOpK7MO2PHvuYx6tcnN0rwAErtuW8bVb0iWMFqJvJfdzO+1J5jW
gT/pFYjM3jTZZlibdYHwSYGTPFArUo/Z5At8MZKXqLNKsUMCAwEAAaNsMGowGgYD
VR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwHQYDVR0OBBYE
FLJwKoh8gKUwkfkbgIIQEBg1zWsHMB8GA1UdIwQYMBaAFOI5E0WKhc/+wP8dCle4
IwLYk3oTMA0GCSqGSIb3DQEBCwUAA4IBAQAAcOqQ1QOnBm11zUjnamj2Co2IgWvL
HvyNQ2BTgwBVqxWtvBc0vf5VW5t9ikV+jq0uhYQJnRLZMKXlhJf73uHMsh1FRM8Z
t4HDNiD3EjHa316EnilTNVH8H+RVDstpQxo9ZXZ2ishFXBuTn1MiX74B72v3Gt5Y
u8NhUh5uAEveCCboMETItLNM6y+LwKfBazfwbnDY6MGcURjRE4/J7P2wEyIy1Ohu
ZcfT/LXbn1H8cBh1iqy9flUsQR3KRTHe84Btck0+O3KA3wGIpRGF1q/mitl7zCNJ
v6SP3sMzDfFDdKbveQk7uRIdMfMMkyDuApZHDuW1YRlQBISLn3G66YOo
-----END CERTIFICATE-----
`;

/** The certificate body lines of `pem`, markers stripped. */
const bodyLines = (pem: string): string[] =>
  pem.trim().split('\n').slice(1, -1);

describe('extractCertificateBlocks', () => {
  it('takes a canonical single-certificate file verbatim', () => {
    expect(extractCertificateBlocks(ROOT_PEM)).toEqual([ROOT_PEM.trim()]);
  });

  it('walks past a marker embedded in a line of prose', () => {
    // Oracle: authorized=true. OpenSSL matches `-----BEGIN ` at the START of a
    // line, so this is a comment it never sees as a block — while counting
    // markers as unanchored substrings saw markers=2 vs blocks=1 and rejected
    // the whole file, dropping a CA the workers would have trusted.
    // Ends WITH the marker on purpose: only line-start anchoring rules this
    // out, so a mutant that merely requires the trailing `-----` still fails.
    const withProse = `# exported by -----BEGIN CERTIFICATE-----\n${ROOT_PEM}`;
    expect(extractCertificateBlocks(withProse)).toEqual([ROOT_PEM.trim()]);
  });

  it('takes a body line carrying interior whitespace', () => {
    // Oracle: authorized=true. The base64 decoder skips whitespace anywhere in
    // the body; a `[A-Za-z0-9+/=]+` line match rejected it.
    const lines = bodyLines(ROOT_PEM);
    const split = [...lines];
    split[1] = `${split[1]!.slice(0, 10)} ${split[1]!.slice(10)}`;
    const spaced = `-----BEGIN CERTIFICATE-----\n${split.join('\n')}\n-----END CERTIFICATE-----\n`;
    expect(extractCertificateBlocks(spaced)).toEqual([ROOT_PEM.trim()]);
  });

  it('takes a block behind a BOM that is not at the start of the file', () => {
    // Oracle: authorized=true. Concatenating operator files puts a BOM in the
    // MIDDLE of the result, and a file-start-anchored strip left
    // a BOM-prefixed `-----BEGIN` line unmatched, so the second cert vanished.
    const concatenated = `${LEAF_PEM}\uFEFF${ROOT_PEM}`;
    expect(extractCertificateBlocks(concatenated)).toEqual([
      LEAF_PEM.trim(),
      ROOT_PEM.trim(),
    ]);
  });

  it('rejects a file whose only block has a fused end line', () => {
    // Oracle: authorized=false, and Node prints `Ignoring extra certs … bad
    // end line`. `cat a.pem b.pem` with no trailing newline in a.pem.
    expect(
      extractCertificateBlocks(`${LEAF_PEM.trimEnd()}${ROOT_PEM}`),
    ).toBeUndefined();
  });

  it('keeps the certificates loaded BEFORE a fused end line', () => {
    // Oracle: authorized=true. The loader is prefix-loading, not
    // all-or-nothing: it keeps everything up to the first malformed block and
    // loses that block and everything after it. Returning `undefined` here
    // would throw away an anchor the workers do receive.
    expect(
      extractCertificateBlocks(`${ROOT_PEM}${LEAF_PEM.trimEnd()}${LEAF_PEM}`),
    ).toEqual([ROOT_PEM.trim()]);
  });

  it('stops at a block whose body does not decode, keeping the prefix', () => {
    // Oracle: authorized=true — `bad base64 decode` ends the loop the same way
    // a bad end line does. Shape is not loadability: this body is made only of
    // base64 characters.
    const lines = bodyLines(ROOT_PEM);
    const corrupted = [...lines];
    corrupted[1] = `${corrupted[1]!.slice(0, 10)}=${corrupted[1]!.slice(11)}`;
    const file = `${ROOT_PEM}-----BEGIN CERTIFICATE-----\n${corrupted.join('\n')}\n-----END CERTIFICATE-----\n`;
    expect(extractCertificateBlocks(file)).toEqual([ROOT_PEM.trim()]);
  });

  it('rejects a block that never closes', () => {
    expect(
      extractCertificateBlocks('-----BEGIN CERTIFICATE-----\nAAAA\n'),
    ).toBeUndefined();
  });

  it('returns undefined for a file with no block at all', () => {
    expect(extractCertificateBlocks('')).toBeUndefined();
    expect(extractCertificateBlocks('not a certificate\n')).toBeUndefined();
  });

  it('leaves a private key out of a combined cert+key file', () => {
    // The merged bundle is written to a tmpdir NODE_EXTRA_CA_CERTS never reads
    // as a key, and a SIGKILLed daemon cannot run the `exit` cleanup — so key
    // material must never reach it.
    const combined = `${ROOT_PEM}-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n`;
    expect(extractCertificateBlocks(combined)).toEqual([ROOT_PEM.trim()]);
  });

  // The key block above is LAST in every fixture that carries one — here and
  // in the supervisor's combined-PEM test — so replacing the scan's `continue`
  // with a `break` shipped green while silently dropping every certificate
  // behind the key. Node's loader keeps them: measured, `rootA + PRIVATE KEY
  // + rootB` as NODE_EXTRA_CA_CERTS authorizes where `rootA` alone fails
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE. cert+key+chain is an ordinary operator
  // file shape, so the dropped certs would be the ones anchoring the workers.
  it('keeps certificates that follow a non-certificate block', () => {
    expect(
      extractCertificateBlocks(
        `${ROOT_PEM}-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n${LEAF_PEM}`,
      ),
    ).toEqual([ROOT_PEM.trim(), LEAF_PEM.trim()]);
  });

  it('normalizes CRLF and marker/body padding to canonical PEM', () => {
    // Oracle: authorized=true for both. The bundle this feeds is written to
    // disk, so the output has to be canonical whatever the input looked like.
    expect(extractCertificateBlocks(ROOT_PEM.replace(/\n/g, '\r\n'))).toEqual([
      ROOT_PEM.trim(),
    ]);
    const padded = ROOT_PEM.trim()
      .split('\n')
      .map((line) => (line.startsWith('-----') ? `${line}  ` : `  ${line}`))
      .join('\n');
    expect(extractCertificateBlocks(padded)).toEqual([ROOT_PEM.trim()]);
  });
});

describe('loadableCertificates', () => {
  it('parses every block it returns', () => {
    const certs = loadableCertificates(`${LEAF_PEM}${ROOT_PEM}`);
    expect(certs?.map((cert) => cert.subject)).toEqual([
      'CN=localhost',
      'CN=Probe Root CA',
    ]);
  });

  it('returns undefined when the loader would take nothing', () => {
    expect(loadableCertificates('not a certificate\n')).toBeUndefined();
  });
});
