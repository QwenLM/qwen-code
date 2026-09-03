/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

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
const UNSUPPORTED_ERROR =
  'Inspecting NODE_EXTRA_CA_CERTS requires Node.js 22.15.0 or newer.';

describe('legacy certificate loader oracle', () => {
  beforeEach(() => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue(legacyOracleResult());
  });

  it.each([
    ['a canonical certificate', ROOT_PEM],
    [
      'a marker with trailing whitespace',
      ROOT_PEM.replace('-----\n', '----- \n'),
    ],
    [
      'the legacy X509 certificate alias',
      ROOT_PEM.replaceAll('CERTIFICATE', 'X509 CERTIFICATE'),
    ],
    [
      'a rejected block before a valid root',
      `-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n${ROOT_PEM}`,
    ],
  ])('fails explicitly instead of modelling %s', (_name, contents) => {
    expect(() => extractCertificateBlocks(contents)).toThrow(UNSUPPORTED_ERROR);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it('does not infer loadability from a legacy warning', () => {
    spawnSync.mockReturnValue(
      legacyOracleResult('Warning: Ignoring extra certs from malformed.pem'),
    );

    expect(() => extractCertificateBlocks(ROOT_PEM)).toThrow(UNSUPPORTED_ERROR);
    expect(spawnSync).toHaveBeenCalledOnce();
  });
});
