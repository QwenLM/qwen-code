/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  BRIDGE_VERSION,
  parseNativePushConfig,
  buildNativeShellsCapability,
  resolveApnsEnabled,
  buildAssetLinks,
} from './nativeShells.js';

const FULL = `
apns:
  enabled: true
  keyPath: ~/.qwen/rc/apns/AuthKey_ABC.p8
  keyId: ABC123
  teamId: DEF456
  bundleId: dev.qwen.rc
  environment: sandbox
androidTwa:
  packageName: dev.qwen.rc
  sha256Fingerprints:
    - "AB:CD:EF"
`;

describe('parseNativePushConfig', () => {
  it('parses a complete config', () => {
    const c = parseNativePushConfig(FULL);
    expect(c.apns).toMatchObject({
      enabled: true,
      keyId: 'ABC123',
      teamId: 'DEF456',
      bundleId: 'dev.qwen.rc',
      environment: 'sandbox',
    });
    expect(c.androidTwa).toEqual({
      packageName: 'dev.qwen.rc',
      sha256Fingerprints: ['AB:CD:EF'],
    });
  });

  it('returns {} for null/empty/invalid input (never throws)', () => {
    expect(parseNativePushConfig(null)).toEqual({});
    expect(parseNativePushConfig('')).toEqual({});
    expect(parseNativePushConfig(': : not yaml :')).toEqual({});
  });

  it('drops an androidTwa block missing packageName or fingerprints', () => {
    expect(
      parseNativePushConfig('androidTwa:\n  packageName: x\n').androidTwa,
    ).toBeUndefined();
    expect(
      parseNativePushConfig('androidTwa:\n  sha256Fingerprints: ["a"]\n')
        .androidTwa,
    ).toBeUndefined();
  });

  it('coerces an unknown environment to undefined and enabled to a strict bool', () => {
    const c = parseNativePushConfig(
      'apns:\n  enabled: "yes"\n  environment: prod\n',
    );
    expect(c.apns?.enabled).toBe(false); // only literal true counts
    expect(c.apns?.environment).toBeUndefined();
  });
});

describe('buildNativeShellsCapability', () => {
  it('carries the bridge version, platforms, and min versions', () => {
    expect(buildNativeShellsCapability(true)).toEqual({
      bridgeVersion: BRIDGE_VERSION,
      apnsEnabled: true,
      supportedPlatforms: ['android-twa', 'ios-wkwebview'],
      minShellVersion: { android: '1.0.0', ios: '1.0.0' },
    });
  });
});

describe('resolveApnsEnabled', () => {
  it('is true only with a complete config AND a readable key', () => {
    const c = parseNativePushConfig(FULL);
    expect(resolveApnsEnabled(c, true)).toBe(true);
    expect(resolveApnsEnabled(c, false)).toBe(false); // key missing
  });

  it('is false when disabled or incomplete', () => {
    expect(resolveApnsEnabled({}, true)).toBe(false);
    expect(
      resolveApnsEnabled({ apns: { enabled: false, keyPath: 'k' } }, true),
    ).toBe(false);
    expect(
      resolveApnsEnabled(
        { apns: { enabled: true, keyPath: 'k' } }, // missing keyId/teamId/bundleId
        true,
      ),
    ).toBe(false);
  });
});

describe('buildAssetLinks', () => {
  it('builds the Android asset statement from TWA config', () => {
    const links = buildAssetLinks(parseNativePushConfig(FULL));
    expect(links).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'dev.qwen.rc',
          sha256_cert_fingerprints: ['AB:CD:EF'],
        },
      },
    ]);
  });

  it('returns null when no TWA is configured (route should 404)', () => {
    expect(buildAssetLinks({})).toBeNull();
  });
});
