/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin wrapper over the OPTIONAL, lazily-loaded `acme-client` (v5) that satisfies
 * the {@link AcmeClient} the {@link AcmeManager} drives. Deliberately minimal: this
 * is the ONE piece of the ACME feature that can't be unit-tested here (it needs the
 * real library + a live CA), so the smallest possible surface keeps any on-box fix
 * localized. The pure `splitPemChain` and the missing-dep path ARE tested.
 *
 * Pinned to acme-client v5 — its crypto surface differs from v4 (`crypto.*` vs
 * `forge.*`). The `auto()` flow places the order, solves each authorization's
 * dns-01 challenge via the {@link DnsProvider}, finalizes with a fresh cert key,
 * and returns the fullchain PEM.
 */
import { X509Certificate } from 'node:crypto';
import type { AcmeClient } from './acmeManager.js';
import type { DnsProvider, DnsChallengeHandle } from './dnsProvider.js';

interface AcmeAuthz {
  identifier: { value: string };
}
interface AcmeChallenge {
  type: string;
}

/** Minimal structural view of acme-client v5 (optional dep, kept out of the type graph). */
interface AcmeClientLib {
  Client: new (opts: { directoryUrl: string; accountKey: string | Buffer }) => {
    auto(opts: {
      csr: Buffer | string;
      email: string;
      termsOfServiceAgreed: boolean;
      challengePriority: string[];
      challengeCreateFn: (
        authz: AcmeAuthz,
        challenge: AcmeChallenge,
        keyAuthorization: string,
      ) => Promise<void>;
      challengeRemoveFn: (
        authz: AcmeAuthz,
        challenge: AcmeChallenge,
        keyAuthorization: string,
      ) => Promise<void>;
    }): Promise<string>;
  };
  crypto: {
    createPrivateKey(): Promise<Buffer>;
    createCsr(opts: {
      commonName: string;
      altNames?: string[];
    }): Promise<[Buffer, Buffer]>;
  };
}

/** Load the optional `acme-client`, or throw an actionable install hint. */
export async function loadAcmeLib(): Promise<AcmeClientLib> {
  const specifier = 'acme-client';
  try {
    return (await import(specifier)) as unknown as AcmeClientLib;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /acme-client/.test(String((err as Error).message))
    ) {
      throw new Error(
        'ACME auto-TLS needs the optional acme-client dependency — run: ' +
          'npm install acme-client',
      );
    }
    throw err;
  }
}

/**
 * Split a fullchain PEM (leaf + issuer chain, as `auto()` returns) into the leaf
 * and the remaining issuer chain — the https server wants them separately.
 */
export function splitPemChain(fullchain: string): {
  leaf: string;
  chain: string;
} {
  const blocks =
    fullchain.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) ?? [];
  if (blocks.length === 0) return { leaf: fullchain.trim(), chain: '' };
  return {
    leaf: `${blocks[0]}\n`,
    chain: blocks
      .slice(1)
      .map((b) => `${b}\n`)
      .join(''),
  };
}

/** Generate a fresh private key PEM via acme-client (used for the ACME account key). */
export async function generateAcmePrivateKey(): Promise<string> {
  const acme = await loadAcmeLib();
  return (await acme.crypto.createPrivateKey()).toString();
}

/** Build the real {@link AcmeClient} backed by `acme-client`. */
export async function createAcmeClient(): Promise<AcmeClient> {
  const acme = await loadAcmeLib();
  return {
    async obtainCertificate(req, provider: DnsProvider) {
      const client = new acme.Client({
        directoryUrl: req.directoryUrl,
        accountKey: req.accountKeyPem,
      });
      const [certKey, csr] = await acme.crypto.createCsr({
        commonName: req.domains[0],
        altNames: req.domains,
      });
      const handles = new Map<string, DnsChallengeHandle>();
      const key = (a: AcmeAuthz, c: AcmeChallenge) =>
        `${a.identifier.value}|${c.type}`;

      const fullchain = await client.auto({
        csr,
        email: req.email,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (challenge.type !== 'dns-01') {
            throw new Error(
              `acme: unexpected challenge "${challenge.type}" (dns-01 only)`,
            );
          }
          // acme-client's auto() passes the READY-TO-USE dns-01 record value as
          // keyAuthorization (already base64url(sha256(token.thumbprint))).
          // VERIFY ON STAGING: if validation fails with a TXT mismatch, this is
          // the one line to revisit (digest vs raw).
          const fqdn = `_acme-challenge.${authz.identifier.value}`;
          handles.set(
            key(authz, challenge),
            await provider.present({ fqdn, value: keyAuthorization }),
          );
        },
        challengeRemoveFn: async (authz, challenge) => {
          const handle = handles.get(key(authz, challenge));
          if (handle) await provider.cleanup(handle);
        },
      });

      const { leaf, chain } = splitPemChain(fullchain);
      return {
        cert: leaf,
        chain,
        privateKey: certKey.toString(),
        notAfter: new Date(new X509Certificate(leaf).validTo),
      };
    },
  };
}
