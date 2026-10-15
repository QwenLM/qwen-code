/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
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

/** `der` as a canonical `CERTIFICATE` block, whatever it decodes to. */
const renderBlock = (der: Buffer): string => {
  const body = der.toString('base64');
  const wrapped: string[] = [];
  for (let at = 0; at < body.length; at += 64) {
    wrapped.push(body.slice(at, at + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${wrapped.join('\n')}\n-----END CERTIFICATE-----\n`;
};

// `tls.getCACertificates` arrives in Node 22.15, while engines still allow
// 22.0: there the loader oracle answers `legacy` and the inspection throws,
// so suites that drive the real oracle skip instead of failing.
const loaderOracleAvailable = typeof tls.getCACertificates === 'function';

describe.skipIf(!loaderOracleAvailable)('extractCertificateBlocks', () => {
  it('ignores NODE_OPTIONS that only affect eval-based oracle children', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ca-preload-'));
    const preload = path.join(dir, 'stdout-preload.cjs');
    fs.writeFileSync(preload, "process.stdout.write('preload noise');\n");
    const previous = process.env['NODE_OPTIONS'];
    try {
      for (const value of ['--input-type=module', `--require=${preload}`]) {
        process.env['NODE_OPTIONS'] = value;
        expect(extractCertificateBlocks(ROOT_PEM)).toEqual([ROOT_PEM.trim()]);
        expect(process.env['NODE_OPTIONS']).toBe(value);
      }
    } finally {
      if (previous === undefined) delete process.env['NODE_OPTIONS'];
      else process.env['NODE_OPTIONS'] = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the loader oracle cannot inspect its source file', () => {
    expect(
      extractCertificateBlocks(
        ROOT_PEM,
        path.join(os.tmpdir(), 'qwen-ca-source-does-not-exist.pem'),
      ),
    ).toBeUndefined();
  });

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

  it('takes and canonicalizes a certificate followed by extra bytes', () => {
    // R4-2. Oracle: authorized=true with no `Ignoring extra certs` warning —
    // the loader parses the DECODED BYTES and tolerates trailing content past
    // a complete DER certificate, while `new X509Certificate(<this PEM>)`
    // throws `wrong tag`. Judging the re-rendered PEM instead made this gate
    // stricter than the loader, so the block and everything behind it were
    // dropped and the operator was told the file holds nothing loadable.
    const padded = renderBlock(
      Buffer.concat([
        new X509Certificate(ROOT_PEM).raw,
        Buffer.from([0, 0, 0]),
      ]),
    );
    expect(extractCertificateBlocks(padded)).toEqual([ROOT_PEM.trim()]);
    expect(() => new X509Certificate(padded)).toThrow();
  });

  it('takes the truncated body a BEGIN marker closes', () => {
    // R4-2. Oracle: authorized=true, no warning. A BEGIN marker inside a body
    // ends that block, and what was collected so far IS the block the loader
    // takes — folding the marker into the body failed the base64 judgment on
    // its `-` characters and dropped the whole file.
    const file = `${ROOT_PEM.replace('-----END CERTIFICATE-----\n', '')}${LEAF_PEM}`;
    expect(extractCertificateBlocks(file)).toEqual([ROOT_PEM.trim()]);
  });

  it('does not treat a BOM-prefixed BEGIN inside a body as a closer', () => {
    const file = ROOT_PEM.replace(
      '-----END CERTIFICATE-----',
      '\uFEFF-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----',
    );
    expect(extractCertificateBlocks(file)).toBeUndefined();
  });

  it('lets a bare BEGIN prefix close an open body before trimming it', () => {
    const withoutEnd = ROOT_PEM.replace('-----END CERTIFICATE-----\n', '');
    for (const marker of ['-----BEGIN ', '-----BEGIN  ']) {
      expect(
        extractCertificateBlocks(`${withoutEnd}${marker}\n${LEAF_PEM}`),
      ).toEqual([ROOT_PEM.trim()]);
    }
  });

  it('lets any column-zero BEGIN prefix close an open body', () => {
    for (const marker of [
      '-----BEGIN BOGUS-LABEL-----',
      '-----BEGIN -----',
      '-----BEGIN BOGUS',
    ]) {
      const file = ROOT_PEM.replace(
        '-----END CERTIFICATE-----',
        `${marker}\n-----END CERTIFICATE-----`,
      );
      expect(extractCertificateBlocks(file)).toEqual([ROOT_PEM.trim()]);
    }
  });

  it('stops at a malformed top-level BEGIN attempt, keeping the prefix', () => {
    for (const marker of ['-----BEGIN BOGUS-LABEL-----', '-----BEGIN -----']) {
      expect(
        extractCertificateBlocks(`${marker}\n${ROOT_PEM}`),
      ).toBeUndefined();
      expect(
        extractCertificateBlocks(`${ROOT_PEM}${marker}\n${ROOT_PEM}`),
      ).toEqual([ROOT_PEM.trim()]);
    }
  });

  it('walks past a paired non-certificate block with an unusual label', () => {
    for (const label of ['BOGUS-LABEL', '']) {
      const block = `-----BEGIN ${label}-----\nQUJD\n-----END ${label}-----\n`;
      expect(extractCertificateBlocks(`${block}${ROOT_PEM}`)).toEqual([
        ROOT_PEM.trim(),
      ]);
    }
  });

  it('walks past a BEGIN prefix without a marker suffix', () => {
    expect(extractCertificateBlocks(`-----BEGIN BOGUS\n${ROOT_PEM}`)).toEqual([
      ROOT_PEM.trim(),
    ]);
  });

  it('stops at markers that fill the loader line buffer', () => {
    const marker = (length: number) =>
      `-----BEGIN ${'A'.repeat(length - 16)}-----`;
    expect(
      extractCertificateBlocks(`${marker(253)}\n${ROOT_PEM}`),
    ).toBeUndefined();
    expect(
      extractCertificateBlocks(`${marker(254)}\n${ROOT_PEM}`),
    ).toBeUndefined();
  });

  it('does not turn a BEGIN marker at EOF into a body closer', () => {
    const withoutEnd = ROOT_PEM.replace('-----END CERTIFICATE-----\n', '');
    for (const suffix of [
      '-----BEGIN CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\n',
    ]) {
      expect(
        extractCertificateBlocks(`${withoutEnd}${suffix}`),
      ).toBeUndefined();
    }
  });

  it('does not close an open certificate on a mismatched BEGIN label', () => {
    const withoutEnd = ROOT_PEM.replace('-----END CERTIFICATE-----\n', '');
    const key =
      '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n';
    expect(extractCertificateBlocks(`${withoutEnd}${key}`)).toBeUndefined();
  });

  it('follows the loader NUL boundary on marker and body lines', () => {
    const firstBodyLine = bodyLines(ROOT_PEM)[0]!;
    for (const file of [
      ROOT_PEM.replace(
        '-----BEGIN CERTIFICATE-----',
        '-----BEGIN CERTIFICATE-----\0junk',
      ),
      ROOT_PEM.replace(firstBodyLine, `${firstBodyLine}\0junk`),
      ROOT_PEM.replace(
        '-----END CERTIFICATE-----',
        '-----END CERTIFICATE-----\0junk',
      ),
    ]) {
      expect(extractCertificateBlocks(file)).toEqual([ROOT_PEM.trim()]);
    }
  });

  it('follows the loader BOM boundary on separators and end markers', () => {
    const body = bodyLines(ROOT_PEM).join('\n');
    for (const file of [
      `-----BEGIN CERTIFICATE-----\n\uFEFF\uFEFF\n${body}\n-----END CERTIFICATE-----\n`,
      `-----BEGIN CERTIFICATE-----\n \uFEFF\n${body}\n-----END CERTIFICATE-----\n`,
      ROOT_PEM.replace(
        '-----END CERTIFICATE-----',
        '-----END CERTIFICATE-----\uFEFF',
      ),
    ]) {
      expect(extractCertificateBlocks(file)).toEqual([ROOT_PEM.trim()]);
    }
  });

  it('stops when an END label introduces an unterminated header', () => {
    const block = '-----BEGIN FOO:BAR-----\nQUJD\n-----END FOO:BAR-----\n';
    expect(extractCertificateBlocks(`${block}${ROOT_PEM}`)).toBeUndefined();
  });

  it('takes nothing behind the block a BEGIN marker closed', () => {
    // R4-2. The half that says the loader STOPS there rather than resuming at
    // the inner marker. Oracle for `[leaf without its END line][root]`:
    // authorized=FALSE (UNABLE_TO_VERIFY_LEAF_SIGNATURE) with no warning —
    // the leaf is taken, the root behind it is not. Resuming at the marker
    // would report an anchor the workers never receive.
    const file = `${LEAF_PEM.replace('-----END CERTIFICATE-----\n', '')}${ROOT_PEM}`;
    expect(extractCertificateBlocks(file)).toEqual([LEAF_PEM.trim()]);
    const behind = `${LEAF_PEM}${LEAF_PEM.replace('-----END CERTIFICATE-----\n', '')}${ROOT_PEM}`;
    expect(extractCertificateBlocks(behind)).toEqual([
      LEAF_PEM.trim(),
      LEAF_PEM.trim(),
    ]);
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

  it('walks past a block whose BEGIN marker is indented', () => {
    // Oracle: authorized=false, with no `Ignoring extra certs` warning, and
    // `openssl storeutl -certs` reports 0 — the loader anchors its marker
    // match at column 0, so an indented BEGIN is prose it never opens a block
    // on. Counting it as an anchor reported zero trust gaps at boot while
    // every worker handshake failed UNABLE_TO_VERIFY_LEAF_SIGNATURE.
    for (const pad of [' ', '  ', '\t']) {
      expect(extractCertificateBlocks(`${pad}${ROOT_PEM}`)).toBeUndefined();
    }
  });

  it('keeps the prefix when a later block has an indented BEGIN marker', () => {
    // Same column-0 rule, reached through the prefix-loading path: the good
    // root still anchors, the indented block does not.
    expect(extractCertificateBlocks(`${ROOT_PEM}  ${LEAF_PEM}`)).toEqual([
      ROOT_PEM.trim(),
    ]);
  });

  it('rejects a block whose END marker is indented', () => {
    // An indented END is not an end line, so the loader reads to EOF looking
    // for one and stops on `bad end line`, the same as a block that never
    // closes.
    const indentedEnd = ROOT_PEM.replace(
      '-----END CERTIFICATE-----',
      '  -----END CERTIFICATE-----',
    );
    expect(extractCertificateBlocks(indentedEnd)).toBeUndefined();
  });

  it('stops at a NON-certificate block whose body does not decode', () => {
    // Oracle: authorized=false for `bad key block + good root` while the same
    // file without the key block is authorized=true. The loader decodes every
    // block's body whatever its label, so a corrupt key block ahead of the
    // chain takes the whole file down — skipping non-certificate blocks
    // unvalidated counted an anchor the workers never received.
    const file = `-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----\n${ROOT_PEM}`;
    expect(extractCertificateBlocks(file)).toBeUndefined();
  });

  it('stops at an empty block body under any label', () => {
    // Oracle: authorized=false for both shapes — an empty body is a decode
    // failure, not an empty-but-fine block.
    expect(
      extractCertificateBlocks(
        `-----BEGIN FOO-----\n-----END FOO-----\n${ROOT_PEM}`,
      ),
    ).toBeUndefined();
    expect(
      extractCertificateBlocks(
        `-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n${ROOT_PEM}`,
      ),
    ).toBeUndefined();
  });

  it('takes the certificate from a key-BEFORE-cert file', () => {
    // Oracle: authorized=true, identical to the cert-only control — `cat
    // key.pem chain.pem` is a real secret-manager export shape. The
    // skip-and-continue path was only ever pinned cert-first, where a
    // stop-at-first-non-certificate mutant still ships green.
    const keyFirst = `-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n${ROOT_PEM}`;
    expect(extractCertificateBlocks(keyFirst)).toEqual([ROOT_PEM.trim()]);
  });

  it('takes a block under the legacy X509 CERTIFICATE label', () => {
    // Oracle: authorized=true. `X509 CERTIFICATE` is OpenSSL's legacy alias
    // and the loader reads a certificate from it; recognising only the modern
    // spelling returned `undefined` for the whole file, so
    // `resolveWorkerCaCertPath` took the no-operator-blocks fallback and handed
    // workers the daemon cert alone.
    const aliased = ROOT_PEM.replace(
      /(BEGIN|END) CERTIFICATE/g,
      '$1 X509 CERTIFICATE',
    );
    expect(extractCertificateBlocks(aliased)).toEqual([ROOT_PEM.trim()]);
  });

  it('stops at a body that is alphabet-valid but does not decode', () => {
    // Oracle: authorized=false, `bad base64 decode`, for both shapes — the
    // loader takes NOTHING, including the root behind them. The alphabet test
    // this replaces passed both and read straight on, counting an anchor the
    // workers never received.
    for (const body of ['====', 'AAAAA']) {
      expect(
        extractCertificateBlocks(
          `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n${ROOT_PEM}`,
        ),
      ).toBeUndefined();
    }
  });

  it('rejects a BOM in front of an END marker', () => {
    // Oracle: authorized=false — the BOM's tolerance is positional. Stripping
    // it from every line made this an ordinary end line and returned the block
    // as an anchor, while the loader takes nothing from the file.
    expect(
      extractCertificateBlocks(
        ROOT_PEM.replace(
          '-----END CERTIFICATE-----',
          '\uFEFF-----END CERTIFICATE-----',
        ),
      ),
    ).toBeUndefined();
  });

  it('rejects a BOM inside a base64 body line', () => {
    // Oracle: authorized=false, `bad base64 decode`. A BOM is not whitespace
    // to the decoder, so a `\s`-based strip silently repaired a file the
    // loader refuses.
    const lines = bodyLines(ROOT_PEM);
    const withBom = [...lines];
    withBom[0] = `${withBom[0]!.slice(0, 10)}\uFEFF${withBom[0]!.slice(10)}`;
    expect(
      extractCertificateBlocks(
        `-----BEGIN CERTIFICATE-----\n${withBom.join('\n')}\n-----END CERTIFICATE-----\n`,
      ),
    ).toBeUndefined();
  });

  it('takes a block whose header section is empty', () => {
    // Oracle: authorized=true for both an empty line and a BOM-only line
    // directly after BEGIN — the loader splits the block there and reads the
    // rest as data. The BOM-only line is the loader's own separator, not a
    // body line, which is why it must not be judged as base64.
    for (const separator of ['', '\uFEFF']) {
      expect(
        extractCertificateBlocks(
          `-----BEGIN CERTIFICATE-----\n${separator}\n${bodyLines(ROOT_PEM).join('\n')}\n-----END CERTIFICATE-----\n`,
        ),
      ).toEqual([ROOT_PEM.trim()]);
    }
  });

  it('stops when a second blank line appears in the data region', () => {
    const lines = bodyLines(ROOT_PEM);
    for (const malformed of [
      `-----BEGIN CERTIFICATE-----\n\n\n${lines.join('\n')}\n-----END CERTIFICATE-----\n${LEAF_PEM}`,
      `-----BEGIN CERTIFICATE-----\n\n${lines.join('\n')}\n\n-----END CERTIFICATE-----\n${LEAF_PEM}`,
      `-----BEGIN PRIVATE KEY-----\nComment: key\n\nQUJD\n\n-----END PRIVATE KEY-----\n${ROOT_PEM}`,
    ]) {
      expect(extractCertificateBlocks(malformed)).toBeUndefined();
    }
  });

  it('stops at a blank line that splits a body into a header section', () => {
    // Oracle: authorized=false, `not proc type` — the loader reads everything
    // before the first blank line as RFC 1421 headers, and headers without
    // `Proc-Type` fail the whole load. A hand-edited body picks this up. The
    // trailing leaf makes the stop observable: a mutant that merely SKIPS the
    // block the way it skips a well-formed encrypted key would return it.
    const lines = bodyLines(ROOT_PEM);
    for (const separator of ['', '\uFEFF']) {
      expect(
        extractCertificateBlocks(
          `-----BEGIN CERTIFICATE-----\n${lines[0]}\n${separator}\n${lines.slice(1).join('\n')}\n-----END CERTIFICATE-----\n${LEAF_PEM}`,
        ),
      ).toBeUndefined();
    }
  });

  it('stops at a header section that carries no Proc-Type', () => {
    // Oracle: authorized=false, `not proc type`. The trailing leaf separates
    // stopping from skipping.
    expect(
      extractCertificateBlocks(
        `-----BEGIN CERTIFICATE-----\nComment: exported by hand\n\n${bodyLines(ROOT_PEM).join('\n')}\n-----END CERTIFICATE-----\n${LEAF_PEM}`,
      ),
    ).toBeUndefined();
  });

  it('stops at a header line the block never terminates', () => {
    // Oracle: authorized=false. A header with no blank line after it leaves
    // the loader's header state unresolved and it takes nothing — not even the
    // leaf behind it.
    expect(
      extractCertificateBlocks(
        `-----BEGIN CERTIFICATE-----\nComment: exported by hand\n${bodyLines(ROOT_PEM).join('\n')}\n-----END CERTIFICATE-----\n${LEAF_PEM}`,
      ),
    ).toBeUndefined();
  });

  it('reads past a legacy encrypted key block to the certificates behind it', () => {
    // Oracle: authorized=true. `Proc-Type:` / `DEK-Info:` are headers the
    // loader consumes as headers — it skips the key and loads every
    // certificate after it. Folding those lines into the base64 judgment
    // aborted the scan and lost the operator's CA.
    const encryptedKey =
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      'Proc-Type: 4,ENCRYPTED\n' +
      'DEK-Info: DES-EDE3-CBC,0123456789ABCDEF\n' +
      '\n' +
      'AAAA\n' +
      '-----END RSA PRIVATE KEY-----\n';
    expect(extractCertificateBlocks(`${encryptedKey}${ROOT_PEM}`)).toEqual([
      ROOT_PEM.trim(),
    ]);
  });

  it('reads past a headed NON-certificate block to the certificates behind it', () => {
    // Oracle: authorized=true for every label below, measured through real
    // NODE_EXTRA_CA_CERTS handshakes on Node v22.23.0 / OpenSSL 3.0.13. The
    // loader inspects a header section only on a block it tries to consume,
    // and it consumes certificate labels alone — so RFC 1421's
    // `Proc-Type`-first rule binds there and NOWHERE else. Applying it to
    // every label made this module return `undefined` for an operator file the
    // workers' own loader reads, and the merge then discarded the operator CA
    // and blamed marker defects the file does not have.
    //
    // `TRUSTED CERTIFICATE` belongs in this list, not with the certificate
    // labels: the loader takes no certificate from it either.
    for (const label of [
      'PRIVATE KEY',
      'RSA PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
      'TRUSTED CERTIFICATE',
      'X509 CRL',
      'CERTIFICATE REQUEST',
      'PUBLIC KEY',
    ]) {
      expect(
        extractCertificateBlocks(
          `-----BEGIN ${label}-----\nComment: exported by hand\n\nQUJD\n-----END ${label}-----\n${ROOT_PEM}`,
        ),
      ).toEqual([ROOT_PEM.trim()]);
    }
  });

  it('stops at a Proc-Type header section under a certificate label', () => {
    // Oracle: authorized=false. A `Proc-Type` header does not spare a
    // certificate block — the loader goes on to DECRYPT it and aborts the file
    // `bad decrypt` with a `DEK-Info` line and `not dek info` without one.
    // Skipping such a block the way a well-formed encrypted KEY is skipped
    // read straight past a stop; the trailing leaf makes that visible.
    for (const headers of [
      'Proc-Type: 4,ENCRYPTED\nDEK-Info: DES-EDE3-CBC,0123456789ABCDEF',
      'Proc-Type: 4,ENCRYPTED',
    ]) {
      for (const label of ['CERTIFICATE', 'X509 CERTIFICATE']) {
        expect(
          extractCertificateBlocks(
            `-----BEGIN ${label}-----\n${headers}\n\n${bodyLines(ROOT_PEM).join('\n')}\n-----END ${label}-----\n${LEAF_PEM}`,
          ),
        ).toBeUndefined();
      }
    }
  });

  it('stops at a headed block whose body below the headers cannot decode', () => {
    // Oracle: authorized=false, `bad base64 decode`. The loader decodes the
    // body BELOW a header section too, so skipping a headed block without
    // judging its base64 read past a stop and reported the trailing root as an
    // anchor the workers never got. `AAAAA` is alphabet-valid and still fails,
    // and a header section with no body at all takes nothing either.
    for (const body of ['!!!!', 'AAAAA', '']) {
      expect(
        extractCertificateBlocks(
          '-----BEGIN RSA PRIVATE KEY-----\n' +
            'Proc-Type: 4,ENCRYPTED\n' +
            'DEK-Info: DES-EDE3-CBC,0123456789ABCDEF\n' +
            `\n${body === '' ? '' : `${body}\n`}` +
            `-----END RSA PRIVATE KEY-----\n${ROOT_PEM}`,
        ),
      ).toBeUndefined();
    }
  });

  it('takes a body wrapped at a non-canonical column', () => {
    // Oracle: authorized=true. The decoder judges the joined body, not each
    // line, so a 63-column rewrap (some exporters do this) still loads.
    const encoded = bodyLines(ROOT_PEM).join('');
    const rewrapped: string[] = [];
    for (let at = 0; at < encoded.length; at += 63) {
      rewrapped.push(encoded.slice(at, at + 63));
    }
    expect(
      extractCertificateBlocks(
        `-----BEGIN CERTIFICATE-----\n${rewrapped.join('\n')}\n-----END CERTIFICATE-----\n`,
      ),
    ).toEqual([ROOT_PEM.trim()]);
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

  it('normalizes every loader-trimmed marker and separator byte', () => {
    for (const whitespace of ['\v', '\f']) {
      for (const marker of [
        ROOT_PEM.replace(
          '-----BEGIN CERTIFICATE-----',
          `-----BEGIN CERTIFICATE-----${whitespace}`,
        ),
        ROOT_PEM.replace(
          '-----END CERTIFICATE-----',
          `-----END CERTIFICATE-----${whitespace}`,
        ),
        `-----BEGIN CERTIFICATE-----\n${whitespace}\n${bodyLines(ROOT_PEM).join('\n')}\n-----END CERTIFICATE-----\n`,
      ]) {
        expect(extractCertificateBlocks(marker)).toEqual([ROOT_PEM.trim()]);
      }
    }
  });
});

describe.skipIf(!loaderOracleAvailable)('loadableCertificates', () => {
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

  it('parses a block whose body carries extra bytes past the certificate', () => {
    // R4-2. The scan's gate reads the decoded bytes, so this function must
    // carry the certificate the scan already parsed rather than re-parsing
    // the rendered PEM — which throws `wrong tag` for exactly this shape and
    // would have turned a block the loader takes into an unhandled throw at
    // boot.
    const padded = renderBlock(
      Buffer.concat([
        new X509Certificate(ROOT_PEM).raw,
        Buffer.from([0, 0, 0]),
      ]),
    );
    expect(loadableCertificates(padded)?.map((cert) => cert.subject)).toEqual([
      'CN=Probe Root CA',
    ]);
  });
});
