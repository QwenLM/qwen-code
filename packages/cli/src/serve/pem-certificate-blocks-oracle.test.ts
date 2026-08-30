/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { rootCertificates } from 'node:tls';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    default: { ...original, spawnSync },
    spawnSync,
  };
});

import {
  ExtraCaInspectionError,
  extractCertificateBlocks,
  loadableCertificates,
} from './pem-certificate-blocks.js';

const ROOT_PEM = `${rootCertificates[0]!}\n`;
const FAILED_ERROR =
  'Inspecting NODE_EXTRA_CA_CERTS failed before its contents could be judged.';

interface FakeOracleResult {
  error: Error | undefined;
  status: number | null;
  stdout: string;
  stderr: string;
}

const oracleOk = (payload: unknown): FakeOracleResult => ({
  error: undefined,
  status: 0,
  stdout: JSON.stringify(payload),
  stderr: '',
});

/**
 * R22-2: every shape below is "the oracle could not answer" — a spawn
 * failure, a dead or killed child, a truncated or absurd protocol answer.
 * Collapsing them into an empty verdict made consumers strip operator trust
 * roots from worker bundles and blame file contents that were never judged.
 */
const failedOracleResults: ReadonlyArray<readonly [string, FakeOracleResult]> =
  [
    [
      'a spawn error',
      {
        error: new Error('spawn ENOMEM'),
        status: null,
        stdout: '',
        stderr: '',
      },
    ],
    [
      'a non-zero exit',
      { error: undefined, status: 3, stdout: '', stderr: '' },
    ],
    [
      'a killed child',
      { error: undefined, status: null, stdout: '', stderr: '' },
    ],
    [
      'a truncated stdout',
      {
        error: undefined,
        status: 0,
        stdout: '{"certificates": ["-----BEGIN',
        stderr: '',
      },
    ],
    [
      'a non-object answer',
      { error: undefined, status: 0, stdout: '42', stderr: '' },
    ],
    ['a malformed certificates list', oracleOk({ certificates: [42] })],
    ['an unknown protocol', oracleOk({ something: true })],
  ];

describe('certificate loader oracle failures', () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it('returns the blocks a healthy oracle reports', () => {
    spawnSync.mockReturnValue(oracleOk({ certificates: [ROOT_PEM] }));

    expect(extractCertificateBlocks(ROOT_PEM)).toEqual([ROOT_PEM.trim()]);
  });

  it('keeps "the loader takes nothing" for a healthy empty answer', () => {
    spawnSync.mockReturnValue(oracleOk({ certificates: [] }));

    expect(extractCertificateBlocks('not a certificate\n')).toBeUndefined();
  });

  it.each(failedOracleResults)(
    'fails closed instead of answering nothing on %s',
    (_name, result) => {
      spawnSync.mockReturnValue(result);

      expect(() => extractCertificateBlocks(ROOT_PEM)).toThrow(FAILED_ERROR);
      expect(() => extractCertificateBlocks(ROOT_PEM)).toThrow(
        ExtraCaInspectionError,
      );
    },
  );

  it('throws through the certificate wrapper too', () => {
    spawnSync.mockReturnValue(failedOracleResults[0]![1]);

    expect(() => loadableCertificates(ROOT_PEM)).toThrow(
      ExtraCaInspectionError,
    );
  });
});
