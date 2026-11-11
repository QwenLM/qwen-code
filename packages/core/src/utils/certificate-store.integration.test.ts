/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTlsCertificates,
  opensslAvailable,
} from '../test-utils/tlsCertificates.js';
import { resolveCertificateTrust } from './certificate-store.js';

let fixture: Awaited<ReturnType<typeof createTlsCertificates>>;

beforeAll(async () => {
  if (opensslAvailable) fixture = await createTlsCertificates();
});

afterAll(async () => {
  await fixture?.cleanup();
});

function fingerprints(certificates: readonly string[]): string[] {
  return certificates.map(
    (certificate) => new X509Certificate(certificate).fingerprint256,
  );
}

async function withTlsServer(run: (port: number) => Promise<void>) {
  const server = tls.createServer({
    key: fixture.leaf.key,
    cert: fixture.leaf.cert + fixture.intermediate.cert,
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function handshake(
  port: number,
  ca: readonly string[],
  servername = 'localhost',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      servername,
      rejectUnauthorized: true,
      ca: [...ca],
    });
    socket.once('secureConnect', () => {
      socket.end();
      resolve();
    });
    socket.once('error', reject);
  });
}

// Protect the trust boundary with real certificates and handshakes. Mocked CA
// names cannot distinguish roots from intermediate or leaf certificates.
describe.skipIf(!opensslAvailable)('system certificate root selection', () => {
  it('keeps default and extra entries but adds only verified system roots', () => {
    const configuration = resolveCertificateTrust({
      getCACertificates: (source) => {
        if (source === 'default') return [fixture.otherRoot.cert];
        if (source === 'system') {
          return [
            fixture.root.cert + fixture.intermediate.cert,
            fixture.leaf.cert,
            'invalid certificate',
          ];
        }
        if (source === 'extra') return ['explicit-extra'];
        return [];
      },
    });

    expect(configuration.authorities?.[0]).toBe(fixture.otherRoot.cert);
    expect(
      new X509Certificate(configuration.authorities?.[1] ?? '').fingerprint256,
    ).toBe(new X509Certificate(fixture.root.cert).fingerprint256);
    expect(configuration.authorities?.[2]).toBe('explicit-extra');
    expect(configuration.systemCertificateCount).toBe(4);
    expect(configuration.systemRootCertificateCount).toBe(1);
    expect(configuration.systemIgnoredCertificateCount).toBe(2);
    expect(configuration.systemCertificateParseFailureCount).toBe(1);
    expect(configuration.systemCertificateCount).toBe(
      configuration.systemRootCertificateCount +
        configuration.systemIgnoredCertificateCount +
        configuration.systemCertificateParseFailureCount,
    );
  });

  it('accepts a complete chain through a system root and rejects wrong trust or identity', async () => {
    const trusted = resolveCertificateTrust({
      getCACertificates: (source) =>
        source === 'system'
          ? [fixture.root.cert, fixture.intermediate.cert, fixture.leaf.cert]
          : [],
    });
    const wrong = resolveCertificateTrust({
      getCACertificates: (source) =>
        source === 'system' ? [fixture.otherRoot.cert] : [],
    });

    expect(fingerprints(trusted.authorities ?? [])).toEqual([
      new X509Certificate(fixture.root.cert).fingerprint256,
    ]);

    await withTlsServer(async (port) => {
      await expect(handshake(port, trusted.authorities ?? [])).resolves.toBeUndefined();
      await expect(handshake(port, wrong.authorities ?? [])).rejects.toBeDefined();
      await expect(
        handshake(port, trusted.authorities ?? [], 'wrong.example'),
      ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    });
  });
});
