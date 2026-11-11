/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { rootCertificates } from 'node:tls';
import { resolveCertificateTrust } from './certificate-store.js';

const systemRoot = rootCertificates[0];

describe('resolveCertificateTrust', () => {
  it('merges a verified system root with default and extra certificates', () => {
    const setDefaultCACertificates = vi.fn();

    const configuration = resolveCertificateTrust({
      getCACertificates: (source) => {
        if (source === 'default') return ['bundled-ca', systemRoot];
        if (source === 'system') return [systemRoot];
        if (source === 'extra') return ['extra-ca'];
        return [];
      },
      setDefaultCACertificates,
    });

    expect(configuration).toEqual({
      authorities: ['bundled-ca', systemRoot, 'extra-ca'],
      defaultCertificateCount: 2,
      systemCertificateCount: 1,
      systemRootCertificateCount: 1,
      systemIgnoredCertificateCount: 0,
      systemCertificateParseFailureCount: 0,
      extraCertificateCount: 1,
      mergedCertificateCount: 3,
      defaultStoreUpdated: true,
      reason: 'explicit-system-trust',
    });
    expect(setDefaultCACertificates).toHaveBeenCalledWith([
      'bundled-ca',
      systemRoot,
      'extra-ca',
    ]);
  });

  it('returns connector authorities when the default store is immutable', () => {
    const configuration = resolveCertificateTrust({
      getCACertificates: (source) => {
        if (source === 'default') return ['bundled-ca'];
        if (source === 'system') return [systemRoot];
        return [];
      },
    });

    expect(configuration.authorities).toEqual(['bundled-ca', systemRoot]);
    expect(configuration.defaultStoreUpdated).toBe(false);
    expect(configuration.reason).toBe('explicit-system-trust');
  });

  it('keeps connector authorities when the runtime rejects default mutation', () => {
    const configuration = resolveCertificateTrust({
      getCACertificates: (source) =>
        source === 'system' ? [systemRoot] : ['bundled-ca'],
      setDefaultCACertificates: () => {
        throw new Error('immutable');
      },
    });

    expect(configuration.authorities).toEqual(['bundled-ca', systemRoot]);
    expect(configuration.defaultStoreUpdated).toBe(false);
  });

  it('uses runtime defaults when the system store has no verified roots', () => {
    const setDefaultCACertificates = vi.fn();
    const configuration = resolveCertificateTrust({
      getCACertificates: (source) => {
        if (source === 'default') return ['bundled-ca'];
        if (source === 'system') return ['not-a-certificate'];
        return [];
      },
      setDefaultCACertificates,
    });

    expect(configuration.authorities).toBeUndefined();
    expect(configuration.systemRootCertificateCount).toBe(0);
    expect(configuration.systemCertificateParseFailureCount).toBe(1);
    expect(configuration.reason).toBe('system-store-no-trusted-roots');
    expect(setDefaultCACertificates).not.toHaveBeenCalled();
  });

  it('counts duplicate system roots as ignored candidates', () => {
    const configuration = resolveCertificateTrust({
      getCACertificates: (source) =>
        source === 'system' ? [systemRoot, systemRoot] : [],
    });

    expect(configuration.authorities).toEqual([systemRoot]);
    expect(configuration.systemCertificateCount).toBe(2);
    expect(configuration.systemRootCertificateCount).toBe(1);
    expect(configuration.systemIgnoredCertificateCount).toBe(1);
    expect(configuration.systemCertificateParseFailureCount).toBe(0);
  });

  it('uses runtime defaults when the system store is empty', () => {
    const configuration = resolveCertificateTrust({
      getCACertificates: (source) =>
        source === 'default' ? ['bundled-ca'] : [],
      setDefaultCACertificates: vi.fn(),
    });

    expect(configuration.authorities).toBeUndefined();
    expect(configuration.reason).toBe('system-store-empty');
  });

  it('uses runtime defaults when certificate APIs are unavailable', () => {
    const configuration = resolveCertificateTrust({});

    expect(configuration.authorities).toBeUndefined();
    expect(configuration.reason).toBe('certificate-api-unavailable');
  });

  it('uses runtime defaults when reading the certificate store fails', () => {
    const configuration = resolveCertificateTrust({
      getCACertificates: () => {
        throw new Error('unavailable');
      },
    });

    expect(configuration.authorities).toBeUndefined();
    expect(configuration.reason).toBe('certificate-store-read-failed');
  });

  it('leaves Bun certificate selection to its compiled runtime flags', () => {
    const getCACertificates = vi.fn();
    const configuration = resolveCertificateTrust(
      { getCACertificates },
      true,
    );

    expect(configuration.authorities).toBeUndefined();
    expect(configuration.reason).toBe('bun-runtime-default');
    expect(getCACertificates).not.toHaveBeenCalled();
  });
});
