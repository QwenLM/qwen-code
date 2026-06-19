/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On-box validation for the ACME DNS-01 flow (NOT a CI test). Issues a REAL cert
 * from Let's Encrypt **staging** for your domain via your DNS provider, proving the
 * `acme-client` wrapper + DNS-01 solver work end-to-end before the cli wires them
 * in. Staging certs are NOT browser-trusted — that's fine; this checks the flow,
 * not trust. (Switch to production only after staging issues cleanly.)
 *
 * Prereqs on the box:
 *   npm install acme-client            # + @aws-sdk/client-route-53 for route53
 *
 * Route53 example:
 *   ACME_DOMAIN=qwen.example.com ACME_EMAIL=you@example.com \
 *     ACME_DNS_PROVIDER=route53 AWS_ROUTE53_HOSTED_ZONE_ID=Z123 AWS_REGION=us-east-1 \
 *     AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
 *     npx tsx scripts/acme-staging-test.mts
 *
 * Cloudflare example:
 *   ACME_DOMAIN=qwen.example.com ACME_EMAIL=you@example.com \
 *     ACME_DNS_PROVIDER=cloudflare CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE_ID=… \
 *     npx tsx scripts/acme-staging-test.mts
 *
 * Set ACME_PRODUCTION=1 to hit LE production instead (rate-limited — only after
 * staging works). Set ACME_STATE_DIR to keep the issued bundle; default is a tmp dir.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAcmeManager } from '../src/tls/acme/buildAcmeStack.js';

const domains = (process.env['ACME_DOMAIN'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const email = process.env['ACME_EMAIL'] ?? '';
const dnsProvider = process.env['ACME_DNS_PROVIDER'] ?? 'route53';
const staging = process.env['ACME_PRODUCTION'] !== '1';

if (domains.length === 0 || !email) {
  console.error('set ACME_DOMAIN (comma-list ok) and ACME_EMAIL');
  process.exit(2);
}

const baseDir =
  process.env['ACME_STATE_DIR'] ??
  (await mkdtemp(join(tmpdir(), 'acme-staging-')));

console.error(`[acme] state dir:   ${baseDir}`);
console.error(`[acme] directory:   ${staging ? 'LE STAGING' : 'LE PRODUCTION'}`);
console.error(`[acme] provider:    ${dnsProvider}`);
console.error(`[acme] domains:     ${domains.join(', ')}`);

try {
  const manager = await buildAcmeManager(
    { domains, email, dnsProvider, staging },
    { baseDir, log: (m) => console.error(`[acme] ${m}`) },
  );
  const bundle = await manager.start();
  manager.stop();
  console.error('');
  console.error(`[acme] ✅ SUCCESS — certificate issued`);
  console.error(`[acme]    notAfter:   ${bundle.meta.notAfter}`);
  console.error(`[acme]    leaf bytes: ${bundle.cert.length}`);
  console.error(`[acme]    chain bytes:${bundle.chain.length}`);
  if (staging) {
    console.error(
      '[acme]    (LE STAGING cert — not browser-trusted; the FLOW works. ' +
        'Re-run with ACME_PRODUCTION=1 for a real cert.)',
    );
  }
  process.exit(0);
} catch (err) {
  console.error('');
  console.error(`[acme] ❌ FAILED: ${(err as Error)?.message ?? err}`);
  console.error(
    '[acme]    (DNS-01 TXT mismatch? see the VERIFY-ON-STAGING note in ' +
      'src/tls/acme/acmeClient.ts. Missing dep? install acme-client / aws sdk.)',
  );
  process.exit(1);
}
