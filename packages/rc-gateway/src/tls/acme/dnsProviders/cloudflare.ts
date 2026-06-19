/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cloudflare DNS-01 solver. `present` creates the `_acme-challenge` TXT record via
 * the Cloudflare v4 API and waits a short propagation window (Cloudflare has no
 * Route53-style INSYNC signal; the edge converges within seconds and ACME also
 * retries). `cleanup` deletes it (best-effort).
 *
 * Logic takes an injectable {@link CloudflareApi} (unit-tested with a fake);
 * {@link createCloudflareApi} is the real `fetch`-based client (no SDK needed) —
 * the token comes from `CLOUDFLARE_API_TOKEN`, the zone id from
 * `CLOUDFLARE_ZONE_ID`.
 */
import type {
  DnsProvider,
  DnsChallengeRecord,
  DnsChallengeHandle,
} from '../dnsProvider.js';

export interface CloudflareApi {
  createTxt(input: {
    zoneId: string;
    name: string;
    value: string;
    ttl: number;
  }): Promise<{ recordId: string }>;
  deleteTxt(input: { zoneId: string; recordId: string }): Promise<void>;
}

export interface CloudflareProviderOptions {
  api: CloudflareApi;
  /** Zone id owning the challenge domain (env `CLOUDFLARE_ZONE_ID`). */
  zoneId: string;
  /** TTL for the challenge record (default 60s). */
  ttl?: number;
  /** Propagation grace before validation (default 10s). */
  propagationWaitMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = { ttl: 60, propagationWaitMs: 10_000 };

export class CloudflareDnsProvider implements DnsProvider {
  readonly name = 'cloudflare';

  constructor(private readonly opts: CloudflareProviderOptions) {}

  async present(record: DnsChallengeRecord): Promise<DnsChallengeHandle> {
    const { recordId } = await this.opts.api.createTxt({
      zoneId: this.opts.zoneId,
      name: record.fqdn,
      value: record.value,
      ttl: this.opts.ttl ?? DEFAULTS.ttl,
    });
    const sleep =
      this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    await sleep(this.opts.propagationWaitMs ?? DEFAULTS.propagationWaitMs);
    return { ...record, zoneId: this.opts.zoneId, recordId };
  }

  async cleanup(handle: DnsChallengeHandle): Promise<void> {
    try {
      await this.opts.api.deleteTxt({
        zoneId: String(handle['zoneId'] ?? this.opts.zoneId),
        recordId: String(handle['recordId'] ?? ''),
      });
    } catch {
      // best-effort: an already-deleted record must not surface.
    }
  }
}

interface CfResponse {
  status: number;
  json(): Promise<unknown>;
}
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<CfResponse>;

interface CfBody {
  success?: boolean;
  result?: { id?: string };
  errors?: Array<{ message?: string }>;
}

/**
 * Real {@link CloudflareApi} over `fetch` (global; no dependency). `token` is the
 * Cloudflare API token (`CLOUDFLARE_API_TOKEN`). `fetchImpl`/`baseUrl` are
 * injectable for tests.
 */
export function createCloudflareApi(opts: {
  token: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}): CloudflareApi {
  const fetchImpl =
    opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.baseUrl ?? 'https://api.cloudflare.com/client/v4';
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
  };
  const check = async (res: CfResponse, ctx: string): Promise<CfBody> => {
    const body = (await res.json()) as CfBody;
    if (res.status >= 300 || body.success === false) {
      const msg =
        body.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join('; ') || `HTTP ${res.status}`;
      throw new Error(`cloudflare ${ctx} failed: ${msg}`);
    }
    return body;
  };
  return {
    async createTxt({ zoneId, name, value, ttl }) {
      const res = await fetchImpl(
        `${base}/zones/${encodeURIComponent(zoneId)}/dns_records`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ type: 'TXT', name, content: value, ttl }),
        },
      );
      const body = await check(res, 'create TXT');
      return { recordId: body.result?.id ?? '' };
    },
    async deleteTxt({ zoneId, recordId }) {
      const res = await fetchImpl(
        `${base}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        { method: 'DELETE', headers },
      );
      await check(res, 'delete TXT');
    },
  };
}
