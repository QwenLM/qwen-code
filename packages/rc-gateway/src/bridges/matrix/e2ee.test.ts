/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseE2eeEnabled,
  olmStoreDir,
  decideMatrixTransport,
  OLM_STORE_DIRNAME,
} from './e2ee.js';

describe('parseE2eeEnabled', () => {
  it('is OFF by default (unset / empty / unrecognized)', () => {
    expect(parseE2eeEnabled(undefined)).toBe(false);
    expect(parseE2eeEnabled('')).toBe(false);
    expect(parseE2eeEnabled('maybe')).toBe(false);
    expect(parseE2eeEnabled('0')).toBe(false);
    expect(parseE2eeEnabled('false')).toBe(false);
  });

  it('accepts the truthy spellings case-insensitively', () => {
    for (const v of ['1', 'true', 'TRUE', 'Yes', 'on', ' on ']) {
      expect(parseE2eeEnabled(v)).toBe(true);
    }
  });
});

describe('olmStoreDir', () => {
  it('is the olm/ subdir of the state dir', () => {
    expect(olmStoreDir('/state/matrix')).toBe(
      `/state/matrix/${OLM_STORE_DIRNAME}`,
    );
    expect(olmStoreDir('/state/matrix')).toBe('/state/matrix/olm');
  });
});

describe('decideMatrixTransport', () => {
  it('plain for an unencrypted room regardless of flags', () => {
    expect(
      decideMatrixTransport({
        encrypted: false,
        e2eeEnabled: false,
        cryptoAvailable: false,
      }),
    ).toBe('plain');
    expect(
      decideMatrixTransport({
        encrypted: false,
        e2eeEnabled: true,
        cryptoAvailable: true,
      }),
    ).toBe('plain');
  });

  it('refuses an encrypted room when E2EE is disabled (the default)', () => {
    expect(
      decideMatrixTransport({
        encrypted: true,
        e2eeEnabled: false,
        cryptoAvailable: true,
      }),
    ).toBe('refuse');
  });

  it('refuses an encrypted room when enabled but the adapter is not built/loaded', () => {
    expect(
      decideMatrixTransport({
        encrypted: true,
        e2eeEnabled: true,
        cryptoAvailable: false,
      }),
    ).toBe('refuse');
  });

  it('routes to crypto only when encrypted AND enabled AND available', () => {
    expect(
      decideMatrixTransport({
        encrypted: true,
        e2eeEnabled: true,
        cryptoAvailable: true,
      }),
    ).toBe('crypto');
  });
});
