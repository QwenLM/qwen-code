/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { rootCertificates } from 'node:tls';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({
    error: undefined,
    status: 0,
    stdout: JSON.stringify({ legacy: true }),
    stderr: '',
  })),
}));

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

describe('legacy certificate loader oracle', () => {
  beforeEach(() => spawnSync.mockClear());

  it('accepts a strict certificate-only file', () => {
    expect(extractCertificateBlocks(ROOT_PEM)).toHaveLength(1);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it('fails closed when strict blocks do not cover the whole file', () => {
    const malformed = '-----BEGIN FOO:BAR-----\nQUJD\n-----END FOO:BAR-----\n';
    expect(extractCertificateBlocks(`${malformed}${ROOT_PEM}`)).toBeUndefined();
    expect(spawnSync).toHaveBeenCalledOnce();
  });
});
