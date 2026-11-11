/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nodeTls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { runLogger } from './runLogger.js';

type CACertificateSource = 'default' | 'system' | 'bundled' | 'extra';

interface CertificateStore {
  getCACertificates?: (type?: CACertificateSource) => string[];
  setDefaultCACertificates?: (certs: readonly string[]) => void;
}

export interface CertificateTrustConfiguration {
  readonly authorities: readonly string[] | undefined;
  readonly defaultCertificateCount: number;
  /** Number of individual system certificate candidates after splitting PEM bundles. */
  readonly systemCertificateCount: number;
  /** Number of unique verified self-signed system roots added to authorities. */
  readonly systemRootCertificateCount: number;
  /** Number of valid candidates omitted as non-roots or duplicate roots. */
  readonly systemIgnoredCertificateCount: number;
  readonly systemCertificateParseFailureCount: number;
  readonly extraCertificateCount: number;
  readonly mergedCertificateCount: number;
  readonly defaultStoreUpdated: boolean;
  readonly reason:
    | 'explicit-system-trust'
    | 'bun-runtime-default'
    | 'certificate-api-unavailable'
    | 'system-store-empty'
    | 'system-store-no-trusted-roots'
    | 'certificate-store-read-failed';
}

const defaultCertificateStore = nodeTls as unknown as CertificateStore;
let runtimeConfiguration: CertificateTrustConfiguration | undefined;

function isBunRuntime(): boolean {
  const versions = process.versions as Record<string, string | undefined>;
  return versions['bun'] !== undefined && versions['bun'] !== '';
}

function uniqueCertificates(...sources: readonly string[][]): string[] {
  return [...new Set(sources.flat())];
}

const PEM_CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

interface SystemRootSelection {
  readonly roots: string[];
  readonly certificateCount: number;
  readonly ignoredCertificateCount: number;
  readonly parseFailureCount: number;
}

/**
 * System stores can expose chain material and leaf certificates in addition to
 * roots. Passing every entry through an explicit `ca` option can change OpenSSL
 * chain selection, so only verified self-signed CA roots are added here.
 */
function selectSystemRoots(certificates: readonly string[]): SystemRootSelection {
  const roots: string[] = [];
  const seenRoots = new Set<string>();
  let certificateCount = 0;
  let ignoredCertificateCount = 0;
  let parseFailureCount = 0;

  for (const bundle of certificates) {
    const pems = bundle.match(PEM_CERTIFICATE_PATTERN) ?? [bundle];
    for (const pem of pems) {
      certificateCount++;
      try {
        const certificate = new X509Certificate(pem);
        const selfSigned =
          certificate.subject === certificate.issuer &&
          certificate.verify(certificate.publicKey);
        if (certificate.ca && selfSigned && !seenRoots.has(pem)) {
          seenRoots.add(pem);
          roots.push(pem);
        } else {
          ignoredCertificateCount++;
        }
      } catch {
        parseFailureCount++;
      }
    }
  }

  return {
    roots,
    certificateCount,
    ignoredCertificateCount,
    parseFailureCount,
  };
}

/**
 * Resolve connector-level trust independently of mutable Node TLS APIs.
 *
 * Some supported Node runtimes can read the OS certificate store but cannot
 * replace the process-wide default store. Returning an explicit CA collection
 * lets every undici connector trust OS-installed roots in those runtimes.
 */
export function resolveCertificateTrust(
  tlsStore: CertificateStore,
  bunRuntime = false,
): CertificateTrustConfiguration {
  if (bunRuntime) {
    return {
      authorities: undefined,
      defaultCertificateCount: 0,
      systemCertificateCount: 0,
      systemRootCertificateCount: 0,
      systemIgnoredCertificateCount: 0,
      systemCertificateParseFailureCount: 0,
      extraCertificateCount: 0,
      mergedCertificateCount: 0,
      defaultStoreUpdated: false,
      reason: 'bun-runtime-default',
    };
  }

  const getCACertificates = tlsStore.getCACertificates;
  if (typeof getCACertificates !== 'function') {
    return {
      authorities: undefined,
      defaultCertificateCount: 0,
      systemCertificateCount: 0,
      systemRootCertificateCount: 0,
      systemIgnoredCertificateCount: 0,
      systemCertificateParseFailureCount: 0,
      extraCertificateCount: 0,
      mergedCertificateCount: 0,
      defaultStoreUpdated: false,
      reason: 'certificate-api-unavailable',
    };
  }

  let defaultCertificates: string[];
  let systemCertificates: string[];
  let extraCertificates: string[];
  try {
    defaultCertificates = getCACertificates('default');
    systemCertificates = getCACertificates('system');
    try {
      extraCertificates = getCACertificates('extra');
    } catch {
      // The default collection already includes startup-time extra CAs on
      // runtimes that do not expose the dedicated "extra" source.
      extraCertificates = [];
    }
  } catch {
    return {
      authorities: undefined,
      defaultCertificateCount: 0,
      systemCertificateCount: 0,
      systemRootCertificateCount: 0,
      systemIgnoredCertificateCount: 0,
      systemCertificateParseFailureCount: 0,
      extraCertificateCount: 0,
      mergedCertificateCount: 0,
      defaultStoreUpdated: false,
      reason: 'certificate-store-read-failed',
    };
  }

  if (systemCertificates.length === 0) {
    return {
      authorities: undefined,
      defaultCertificateCount: defaultCertificates.length,
      systemCertificateCount: 0,
      systemRootCertificateCount: 0,
      systemIgnoredCertificateCount: 0,
      systemCertificateParseFailureCount: 0,
      extraCertificateCount: extraCertificates.length,
      mergedCertificateCount: 0,
      defaultStoreUpdated: false,
      reason: 'system-store-empty',
    };
  }

  const systemRoots = selectSystemRoots(systemCertificates);
  if (systemRoots.roots.length === 0) {
    return {
      authorities: undefined,
      defaultCertificateCount: defaultCertificates.length,
      systemCertificateCount: systemRoots.certificateCount,
      systemRootCertificateCount: 0,
      systemIgnoredCertificateCount: systemRoots.ignoredCertificateCount,
      systemCertificateParseFailureCount: systemRoots.parseFailureCount,
      extraCertificateCount: extraCertificates.length,
      mergedCertificateCount: 0,
      defaultStoreUpdated: false,
      reason: 'system-store-no-trusted-roots',
    };
  }

  const authorities = uniqueCertificates(
    defaultCertificates,
    systemRoots.roots,
    extraCertificates,
  );
  let defaultStoreUpdated = false;
  if (typeof tlsStore.setDefaultCACertificates === 'function') {
    try {
      tlsStore.setDefaultCACertificates(authorities);
      defaultStoreUpdated = true;
    } catch {
      // Connector-level CA injection below remains authoritative even when the
      // runtime refuses to mutate its process-wide default store.
    }
  }

  return {
    authorities,
    defaultCertificateCount: defaultCertificates.length,
    systemCertificateCount: systemRoots.certificateCount,
    systemRootCertificateCount: systemRoots.roots.length,
    systemIgnoredCertificateCount: systemRoots.ignoredCertificateCount,
    systemCertificateParseFailureCount: systemRoots.parseFailureCount,
    extraCertificateCount: extraCertificates.length,
    mergedCertificateCount: authorities.length,
    defaultStoreUpdated,
    reason: 'explicit-system-trust',
  };
}

function getRuntimeConfiguration(): CertificateTrustConfiguration {
  if (runtimeConfiguration) return runtimeConfiguration;
  runtimeConfiguration = resolveCertificateTrust(
    defaultCertificateStore,
    isBunRuntime(),
  );
  const configuration = runtimeConfiguration;
  if (configuration.reason === 'explicit-system-trust') {
    runLogger.log(
      `[tls] Certificate trust initialized: mode=explicit-system, ` +
        `defaultCertificates=${configuration.defaultCertificateCount}, ` +
        `systemCertificates=${configuration.systemCertificateCount}, ` +
        `systemRoots=${configuration.systemRootCertificateCount}, ` +
        `systemIgnored=${configuration.systemIgnoredCertificateCount}, ` +
        `systemParseFailures=${configuration.systemCertificateParseFailureCount}, ` +
        `extraCertificates=${configuration.extraCertificateCount}, ` +
        `mergedCertificates=${configuration.mergedCertificateCount}, ` +
        `defaultStoreUpdated=${configuration.defaultStoreUpdated}`,
    );
  } else if (configuration.reason === 'bun-runtime-default') {
    runLogger.log(
      '[tls] Certificate trust initialized: mode=bun-runtime-default',
    );
  } else {
    runLogger.warn(
      `[tls] Certificate trust uses runtime defaults: reason=${configuration.reason}, ` +
        `systemCertificates=${configuration.systemCertificateCount}, ` +
        `systemRoots=${configuration.systemRootCertificateCount}, ` +
        `systemIgnored=${configuration.systemIgnoredCertificateCount}, ` +
        `systemParseFailures=${configuration.systemCertificateParseFailureCount}`,
    );
  }
  return configuration;
}

/**
 * Configure the mutable process-wide store when supported.
 *
 * Network connectors do not depend on this return value: they consume
 * getCertificateAuthorities(), which also works when the setter is absent.
 */
export function configureDefaultCertificateStore(): boolean {
  return getRuntimeConfiguration().defaultStoreUpdated;
}

/** Return the explicit CA collection used by Node-based undici connectors. */
export function getCertificateAuthorities(): readonly string[] | undefined {
  return getRuntimeConfiguration().authorities;
}

/** @internal test-only */
export function _resetCertificateTrustForTesting(): void {
  runtimeConfiguration = undefined;
}
