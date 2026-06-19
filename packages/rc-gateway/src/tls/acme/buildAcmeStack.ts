/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Assemble a ready-to-run {@link AcmeManager} from config + env — the single place
 * the cli (Slice 4) and the staging-test script build the ACME stack. Provider
 * selection, the LE directory choice (staging vs production), and the
 * env-credential checks live here (and are unit-tested); the actual `acme-client`
 * and AWS SDK loads stay lazy.
 */
import { CertStore } from './certStore.js';
import { AcmeManager, type AcmeManagerOptions } from './acmeManager.js';
import { createAcmeClient, generateAcmePrivateKey } from './acmeClient.js';
import {
  Route53DnsProvider,
  createRoute53Client,
} from './dnsProviders/route53.js';
import {
  CloudflareDnsProvider,
  createCloudflareApi,
} from './dnsProviders/cloudflare.js';
import { loadOrCreateAccountKey } from './accountKeyStore.js';
import type { DnsProvider } from './dnsProvider.js';

export const LE_DIRECTORY = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
} as const;

export interface AcmeStackConfig {
  domains: string[];
  email: string;
  /** `route53` | `cloudflare`. */
  dnsProvider: string;
  /** Use LE staging (loose limits, untrusted certs) — default false (production). */
  staging?: boolean;
  /** Explicit ACME directory URL (private CA / Pebble); overrides staging/prod. */
  directoryUrl?: string;
}

/** Resolve the ACME directory: explicit override → staging → production. */
export function resolveDirectoryUrl(config: AcmeStackConfig): string {
  if (config.directoryUrl) return config.directoryUrl;
  return config.staging ? LE_DIRECTORY.staging : LE_DIRECTORY.production;
}

/** Build the configured DNS-01 solver from env credentials. */
export async function buildDnsProvider(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DnsProvider> {
  if (name === 'route53') {
    const hostedZoneId = env['AWS_ROUTE53_HOSTED_ZONE_ID'];
    if (!hostedZoneId) {
      throw new Error(
        'route53 provider needs AWS_ROUTE53_HOSTED_ZONE_ID (plus AWS creds via ' +
          'the standard chain: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION ' +
          'or an instance role)',
      );
    }
    const client = await createRoute53Client(
      env['AWS_REGION'] ? { region: env['AWS_REGION'] } : {},
    );
    return new Route53DnsProvider({ client, hostedZoneId });
  }
  if (name === 'cloudflare') {
    const token = env['CLOUDFLARE_API_TOKEN'];
    const zoneId = env['CLOUDFLARE_ZONE_ID'];
    if (!token || !zoneId) {
      throw new Error(
        'cloudflare provider needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID',
      );
    }
    return new CloudflareDnsProvider({
      api: createCloudflareApi({ token }),
      zoneId,
    });
  }
  throw new Error(
    `unknown --acme-dns-provider "${name}" (supported: route53, cloudflare)`,
  );
}

/** Assemble the full manager: provider + acme-client + cert store + account key. */
export async function buildAcmeManager(
  config: AcmeStackConfig,
  opts: {
    baseDir: string;
    env?: NodeJS.ProcessEnv;
    log?: (msg: string) => void;
    onChange?: AcmeManagerOptions['onChange'];
  },
): Promise<AcmeManager> {
  const env = opts.env ?? process.env;
  const provider = await buildDnsProvider(config.dnsProvider, env);
  const client = await createAcmeClient();
  const store = new CertStore(opts.baseDir);
  return new AcmeManager({
    domains: config.domains,
    email: config.email,
    directoryUrl: resolveDirectoryUrl(config),
    provider,
    client,
    store,
    accountKey: () =>
      loadOrCreateAccountKey(opts.baseDir, generateAcmePrivateKey),
    log: opts.log,
    onChange: opts.onChange,
  });
}
