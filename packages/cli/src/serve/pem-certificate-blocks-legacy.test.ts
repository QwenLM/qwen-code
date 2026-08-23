/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

const legacyOracleResult = (stderr = '') => ({
  error: undefined,
  status: 0,
  stdout: JSON.stringify({ legacy: true }),
  stderr,
});

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    default: { ...original, spawnSync },
    spawnSync,
  };
});

import { extractCertificateBlocks } from './pem-certificate-blocks.js';

const ROOT_PEM = `${rootCertificates[0]!}\n`;
const SECOND_ROOT_PEM = `${rootCertificates[1]!}\n`;

describe('legacy certificate loader oracle', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue(legacyOracleResult());
  });

  it('accepts a strict certificate-only file', () => {
    expect(extractCertificateBlocks(ROOT_PEM)).toHaveLength(1);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it.each([
    ['a leading UTF-8 BOM', `\uFEFF${ROOT_PEM}`, 1],
    ['leading prose', `# exported by secret manager\n${ROOT_PEM}`, 1],
    ['trailing prose', `${ROOT_PEM}# end of export\n`, 1],
    ['inter-block prose', `${ROOT_PEM}# second trust anchor\n${ROOT_PEM}`, 2],
    [
      'leading private key',
      `-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n${ROOT_PEM}`,
      1,
    ],
    [
      'trailing private key',
      `${ROOT_PEM}-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n`,
      1,
    ],
    ['blank line between certificates', `${ROOT_PEM}\n${ROOT_PEM}`, 2],
    ['a trailing NUL', `${ROOT_PEM.trimEnd()}\0`, 1],
    ['a trailing NUL before newline', `${ROOT_PEM.trimEnd()}\0\n`, 1],
    [
      'a NUL-delimited second certificate',
      `${ROOT_PEM.trimEnd()}\0\n${SECOND_ROOT_PEM}`,
      2,
    ],
  ])('accepts %s around loadable certificates', (_name, contents, count) => {
    expect(extractCertificateBlocks(contents)).toHaveLength(count);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it('stops at a leading NUL even when the loader emits no warning', () => {
    expect(extractCertificateBlocks(`\0\n${ROOT_PEM}`)).toBeUndefined();
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it('fails closed on the warning-free legacy header stop', () => {
    const malformed = '-----BEGIN FOO:BAR-----\nQUJD\n-----END FOO:BAR-----\n';
    expect(extractCertificateBlocks(`${malformed}${ROOT_PEM}`)).toBeUndefined();
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it('keeps certificates loaded before a warning-free legacy header stop', () => {
    const malformed = '-----BEGIN FOO:BAR-----\nQUJD\n-----END FOO:BAR-----\n';
    expect(
      extractCertificateBlocks(`${ROOT_PEM}${malformed}${SECOND_ROOT_PEM}`),
    ).toEqual([new X509Certificate(ROOT_PEM).toString().trimEnd()]);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it('fails closed when the legacy loader reports malformed extra certs', () => {
    spawnSync.mockReturnValue(
      legacyOracleResult('Warning: Ignoring extra certs from malformed.pem'),
    );

    expect(extractCertificateBlocks(ROOT_PEM)).toBeUndefined();
    expect(spawnSync).toHaveBeenCalledOnce();
  });
});
