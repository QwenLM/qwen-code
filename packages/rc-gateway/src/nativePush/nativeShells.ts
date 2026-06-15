/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure config + capability logic for add-native-mobile-shells (Cycle B). Parses
 * the optional `~/.qwen/rc/native-push.yaml`, builds the
 * `remoteControl.nativeShells` capability block, and builds the Android TWA
 * `assetlinks.json` statement. No fs/network here — cli wiring reads the file and
 * checks the P-8 key's readability; this module is unit-tested in full.
 */

import { parse as parseYaml } from 'yaml';

/** Bridge contract version (the integer agreed for this change). */
export const BRIDGE_VERSION = 1;
export const SUPPORTED_PLATFORMS = ['android-twa', 'ios-wkwebview'] as const;
export const MIN_SHELL_VERSION = { android: '1.0.0', ios: '1.0.0' } as const;

export interface ApnsConfig {
  enabled: boolean;
  keyPath?: string;
  keyId?: string;
  teamId?: string;
  bundleId?: string;
  environment?: 'sandbox' | 'production';
}

export interface AndroidTwaConfig {
  packageName: string;
  sha256Fingerprints: string[];
}

export interface NativePushConfig {
  apns?: ApnsConfig;
  androidTwa?: AndroidTwaConfig;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Parse `native-push.yaml` text to a {@link NativePushConfig}. Tolerant: a
 * missing/empty/invalid file yields `{}` (the loader treats that as "APNs off,
 * no TWA asset link"). Never throws.
 */
export function parseNativePushConfig(text: string | null): NativePushConfig {
  if (!text) return {};
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return {};
  }
  if (!doc || typeof doc !== 'object') return {};
  const root = doc as Record<string, unknown>;
  const out: NativePushConfig = {};

  const apnsRaw = root.apns;
  if (apnsRaw && typeof apnsRaw === 'object') {
    const a = apnsRaw as Record<string, unknown>;
    const env = asString(a.environment);
    out.apns = {
      enabled: a.enabled === true,
      keyPath: asString(a.keyPath),
      keyId: asString(a.keyId),
      teamId: asString(a.teamId),
      bundleId: asString(a.bundleId),
      environment: env === 'production' || env === 'sandbox' ? env : undefined,
    };
  }

  const twaRaw = root.androidTwa;
  if (twaRaw && typeof twaRaw === 'object') {
    const t = twaRaw as Record<string, unknown>;
    const packageName = asString(t.packageName);
    const fps = Array.isArray(t.sha256Fingerprints)
      ? t.sha256Fingerprints.filter(
          (f): f is string => asString(f) !== undefined,
        )
      : [];
    if (packageName && fps.length > 0) {
      out.androidTwa = { packageName, sha256Fingerprints: fps };
    }
  }

  return out;
}

export interface NativeShellsCapability {
  bridgeVersion: number;
  apnsEnabled: boolean;
  supportedPlatforms: string[];
  minShellVersion: { android: string; ios: string };
}

/** Build the `remoteControl.nativeShells` capability block. */
export function buildNativeShellsCapability(
  apnsEnabled: boolean,
): NativeShellsCapability {
  return {
    bridgeVersion: BRIDGE_VERSION,
    apnsEnabled,
    supportedPlatforms: [...SUPPORTED_PLATFORMS],
    minShellVersion: { ...MIN_SHELL_VERSION },
  };
}

/**
 * The APNs sender requires a complete config AND a readable P-8 key, so
 * `apnsEnabled` is true only when the operator turned it on, supplied all the
 * identifiers, and the key file is actually present.
 */
export function resolveApnsEnabled(
  config: NativePushConfig,
  keyReadable: boolean,
): boolean {
  const a = config.apns;
  return !!(
    a?.enabled &&
    a.keyPath &&
    a.keyId &&
    a.teamId &&
    a.bundleId &&
    keyReadable
  );
}

/** The Android Digital Asset Links statement, or `null` when no TWA is configured. */
export function buildAssetLinks(
  config: NativePushConfig,
): Array<Record<string, unknown>> | null {
  const twa = config.androidTwa;
  if (!twa) return null;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: twa.packageName,
        sha256_cert_fingerprints: twa.sha256Fingerprints,
      },
    },
  ];
}
