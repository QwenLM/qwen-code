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
  const crypto = process.binding('crypto');
  process.stdout.write(JSON.stringify({
    fullyLoaded: crypto.isExtraRootCertsFileLoaded(),
  }));
}
`;
const STRICT_CERTIFICATE_BLOCK =
  /^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----[ \t]*(?:\r?\n|$)/gm;

/** A block the loader takes, in canonical PEM and as its parsed certificate. */
interface ScannedCertificateBlock {
  block: string;
  certificate: X509Certificate;
}

function strictCertificateBlocks(contents: string): ScannedCertificateBlock[] {
  const blocks: ScannedCertificateBlock[] = [];
  for (const match of contents.matchAll(STRICT_CERTIFICATE_BLOCK)) {
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
  const dir = sourcePath
    ? undefined
    : mkdtempSync(join(tmpdir(), 'qwen-ca-oracle-'));
  const certPath = sourcePath ?? join(dir!, 'extra-ca.pem');
  try {
    if (dir) writeFileSync(certPath, contents, { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      ['--no-deprecation', '-e', ORACLE_SOURCE],
      {
        encoding: 'utf8',
        env: { ...process.env, [NODE_EXTRA_CA_CERTS_ENV]: certPath },
        maxBuffer: ORACLE_MAX_BUFFER_BYTES,
        timeout: ORACLE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Node certificate loader oracle exited with status ${result.status}: ${result.stderr.trim()}`,
      );
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Node certificate loader oracle returned invalid output');
    }
    const certificates = Reflect.get(parsed, 'certificates');
    if (certificates !== undefined) {
      if (
        !Array.isArray(certificates) ||
        !certificates.every((item) => typeof item === 'string')
      ) {
        throw new Error(
          'Node certificate loader oracle returned invalid certificates',
        );
      }
      return certificates.map((block) => ({
        block: block.trimEnd(),
        certificate: new X509Certificate(block),
      }));
    }
    const fullyLoaded = Reflect.get(parsed, 'fullyLoaded');
    if (typeof fullyLoaded !== 'boolean') {
      throw new Error('Node certificate loader oracle returned invalid output');
    }
    // `tls.getCACertificates('extra')` was added during Node 22. Older Node 22
    // releases expose only the loader's success bit. In that compatibility
    // path, extract a strict subset only after the loader confirms the whole
    // file was accepted; unusual but loadable shapes fail closed and trigger
    // the existing visible merge fallback instead of creating phantom roots.
    return fullyLoaded ? strictCertificateBlocks(contents) : [];
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
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
