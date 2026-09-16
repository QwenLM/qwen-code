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

/** A block the loader takes, in canonical PEM and as its parsed certificate. */
interface ScannedCertificateBlock {
  block: string;
  certificate: X509Certificate;
}

/**
 * The inspection produced no verdict. Callers must treat this as "could not
 * answer", never as "the loader takes nothing": collapsing an inspection that
 * could not run into an empty verdict made consumers strip operator trust
 * roots from worker bundles and blame file contents that were never judged.
 */
export class ExtraCaInspectionError extends Error {}

class LegacyExtraCaInspectionError extends ExtraCaInspectionError {
  constructor() {
    super('Inspecting NODE_EXTRA_CA_CERTS requires Node.js 22.15.0 or newer.');
  }
}

class FailedExtraCaInspectionError extends ExtraCaInspectionError {
  constructor() {
    super(
      'Inspecting NODE_EXTRA_CA_CERTS failed before its contents could be judged.',
    );
  }
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
    if (result.error || result.status !== 0) {
      throw new FailedExtraCaInspectionError();
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new FailedExtraCaInspectionError();
    }
    const certificates = Reflect.get(parsed, 'certificates');
    if (certificates !== undefined) {
      if (
        !Array.isArray(certificates) ||
        !certificates.every((item) => typeof item === 'string')
      ) {
        throw new FailedExtraCaInspectionError();
      }
      return certificates.map((block) => ({
        block: block.trimEnd(),
        certificate: new X509Certificate(block),
      }));
    }
    if (Reflect.get(parsed, 'legacy') !== true) {
      throw new FailedExtraCaInspectionError();
    }
    // Older Node 22 releases expose no certificate list. Their byte-oriented
    // loader cannot be reproduced by a string parser without drifting, so do
    // not silently remove operator trust roots from worker bundles.
    throw new LegacyExtraCaInspectionError();
  } catch (error) {
    if (error instanceof ExtraCaInspectionError) throw error;
    // A truncated stdout, an unmodellable answer, a failed temp write —
    // anything short of a clean oracle verdict is "could not answer", never
    // "the loader takes nothing". Returning [] here used to be
    // indistinguishable from a genuinely unloadable file.
    throw new FailedExtraCaInspectionError();
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
 * `contents`, in file order, or `undefined` when it takes none. Throws an
 * `ExtraCaInspectionError` when the inspection itself cannot run.
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
 * when it takes none of them. Throws an `ExtraCaInspectionError` when the
 * inspection itself cannot run.
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
