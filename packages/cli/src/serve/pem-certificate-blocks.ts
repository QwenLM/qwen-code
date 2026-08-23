/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE_EXTRA_CA_CERTS_ENV = 'NODE_EXTRA_CA_CERTS';
const ORACLE_TIMEOUT_MS = 10_000;
const ORACLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const ORACLE_SOURCE = `
const tls = require('node:tls');
if (typeof tls.getCACertificates === 'function') {
  process.stdout.write(JSON.stringify({
    certificates: tls.getCACertificates('extra'),
  }));
} else {
  tls.createSecureContext();
  process.stdout.write(JSON.stringify({ legacy: true }));
}
`;
const STRICT_CERTIFICATE_BLOCK =
  /^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----[ \t]*(?:\r?\n|$)/gm;
const LEGACY_SILENT_STOP_HEADER_BLOCK =
  /^-----BEGIN ([^\r\n]*:[^\r\n]*)-----[ \t]*\r?\n[\s\S]*?^-----END \1-----[ \t]*(?:\r?\n|$)/m;
const LEGACY_CERTIFICATE_END_NUL =
  /^(-----END CERTIFICATE-----[ \t]*)\0(?=\r?\n|$)/gm;

/** A block the loader takes, in canonical PEM and as its parsed certificate. */
interface ScannedCertificateBlock {
  block: string;
  certificate: X509Certificate;
}

function legacyCertificateBlocks(contents: string): ScannedCertificateBlock[] {
  // The legacy line reader skips only a file-start BOM, accepts NUL after an
  // END line, and silently stops at every other NUL.
  const loaderInput = (
    contents.startsWith('\uFEFF') ? contents.slice(1) : contents
  ).replace(LEGACY_CERTIFICATE_END_NUL, '$1');
  const nulStop = loaderInput.indexOf('\0');
  const nulPrefix =
    nulStop === -1 ? loaderInput : loaderInput.slice(0, nulStop);
  const silentStop = nulPrefix.search(LEGACY_SILENT_STOP_HEADER_BLOCK);
  const loadablePrefix =
    silentStop === -1 ? nulPrefix : nulPrefix.slice(0, silentStop);
  const blocks: ScannedCertificateBlock[] = [];
  for (const match of loadablePrefix.matchAll(STRICT_CERTIFICATE_BLOCK)) {
    try {
      const certificate = new X509Certificate(match[0]);
      blocks.push({
        block: certificate.toString().trimEnd(),
        certificate,
      });
    } catch {
      return [];
    }
  }
  return blocks;
}

/**
 * Ask the same Node executable that launches workers which certificates its
 * `NODE_EXTRA_CA_CERTS` loader accepts. OpenSSL's PEM reader has byte-buffer,
 * NUL, BOM, header and prefix-loading semantics that cannot be reproduced by
 * a string parser without drifting from the worker runtime.
 */
function scanCertificateBlocks(
  contents: string,
  sourcePath?: string,
): ScannedCertificateBlock[] {
  // Production already has a source file. Reuse it so a SIGKILL cannot leave
  // a second copy of private-key material from a combined serving PEM behind.
  let dir: string | undefined;
  try {
    dir = sourcePath
      ? undefined
      : mkdtempSync(join(tmpdir(), 'qwen-ca-oracle-'));
    const certPath = sourcePath ?? join(dir!, 'extra-ca.pem');
    if (dir) writeFileSync(certPath, contents, { mode: 0o600 });
    const oracleEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [NODE_EXTRA_CA_CERTS_ENV]: certPath,
    };
    for (const key of Object.keys(oracleEnv)) {
      if (key.toUpperCase() === 'NODE_OPTIONS') delete oracleEnv[key];
    }
    const result = spawnSync(
      process.execPath,
      ['--no-deprecation', '--input-type=commonjs', '-e', ORACLE_SOURCE],
      {
        encoding: 'utf8',
        env: oracleEnv,
        maxBuffer: ORACLE_MAX_BUFFER_BYTES,
        timeout: ORACLE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) return [];
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const certificates = Reflect.get(parsed, 'certificates');
    if (certificates !== undefined) {
      if (
        !Array.isArray(certificates) ||
        !certificates.every((item) => typeof item === 'string')
      ) {
        return [];
      }
      return certificates.map((block) => ({
        block: block.trimEnd(),
        certificate: new X509Certificate(block),
      }));
    }
    if (Reflect.get(parsed, 'legacy') !== true) return [];
    // `tls.getCACertificates('extra')` was added during Node 22. Older Node 22
    // releases expose no certificate list. Creating a secure context drives
    // the same loader and reports most malformed files on stderr. The bounded
    // scanner also stops at the known warning-free header shape, while
    // retaining the loader's measured surrounding-content tolerance.
    return result.stderr.includes('Warning: Ignoring extra certs from')
      ? []
      : legacyCertificateBlocks(contents);
  } catch {
    return [];
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a tmp cleaner may already have taken it.
      }
    }
  }
}

/**
 * The certificate blocks a worker's `NODE_EXTRA_CA_CERTS` loader takes from
 * `contents`, in file order, or `undefined` when it takes none.
 */
export function extractCertificateBlocks(
  contents: string,
  sourcePath?: string,
): string[] | undefined {
  const scanned = scanCertificateBlocks(contents, sourcePath);
  return scanned.length > 0 ? scanned.map((entry) => entry.block) : undefined;
}

/**
 * The certificates a worker's loader takes from `contents`, or `undefined`
 * when it takes none of them.
 */
export function loadableCertificates(
  contents: string,
  sourcePath?: string,
): X509Certificate[] | undefined {
  const scanned = scanCertificateBlocks(contents, sourcePath);
  return scanned.length > 0
    ? scanned.map((entry) => entry.certificate)
    : undefined;
}
