/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AWS Route53 DNS-01 solver. `present` UPSERTs the `_acme-challenge` TXT record
 * into the hosted zone and waits until Route53 reports the change `INSYNC` — its
 * authoritative "fully propagated" signal, so the CA can validate immediately
 * with no extra DNS polling. `cleanup` DELETEs it (best-effort).
 *
 * The Route53 API is taken as an injectable {@link Route53Client} so the solver's
 * logic is unit-tested with no AWS. The real client ({@link createRoute53Client})
 * wraps the OPTIONAL, lazily-loaded `@aws-sdk/client-route-53`.
 */
import type {
  DnsProvider,
  DnsChallengeRecord,
  DnsChallengeHandle,
} from '../dnsProvider.js';

/** A single TXT change the provider asks the Route53 API to apply. */
export interface Route53ChangeInput {
  hostedZoneId: string;
  action: 'UPSERT' | 'DELETE';
  /** Record name (FQDN), e.g. `_acme-challenge.qwen.example.com`. */
  name: string;
  /** Raw TXT value; the client quotes it as Route53 requires. */
  value: string;
  ttl: number;
}

/** The minimal Route53 surface the solver needs (the real impl wraps the SDK). */
export interface Route53Client {
  changeTxtRecord(input: Route53ChangeInput): Promise<{ changeId: string }>;
  getChangeStatus(changeId: string): Promise<'PENDING' | 'INSYNC'>;
}

export interface Route53ProviderOptions {
  client: Route53Client;
  /** The hosted zone id that owns the challenge domain (env-supplied). */
  hostedZoneId: string;
  /** TTL for the challenge record (default 60s — it's short-lived). */
  ttl?: number;
  /** INSYNC poll interval (default 2s). */
  pollIntervalMs?: number;
  /** Max time to wait for INSYNC before failing (default 120s). */
  maxWaitMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULTS = { ttl: 60, pollIntervalMs: 2000, maxWaitMs: 120_000 };

export class Route53DnsProvider implements DnsProvider {
  readonly name = 'route53';

  constructor(private readonly opts: Route53ProviderOptions) {}

  async present(record: DnsChallengeRecord): Promise<DnsChallengeHandle> {
    const { changeId } = await this.opts.client.changeTxtRecord({
      hostedZoneId: this.opts.hostedZoneId,
      action: 'UPSERT',
      name: record.fqdn,
      value: record.value,
      ttl: this.opts.ttl ?? DEFAULTS.ttl,
    });
    await this.waitInSync(changeId);
    return {
      ...record,
      hostedZoneId: this.opts.hostedZoneId,
      changeId,
    };
  }

  async cleanup(handle: DnsChallengeHandle): Promise<void> {
    try {
      await this.opts.client.changeTxtRecord({
        hostedZoneId: String(handle['hostedZoneId'] ?? this.opts.hostedZoneId),
        action: 'DELETE',
        name: handle.fqdn,
        value: handle.value,
        ttl: this.opts.ttl ?? DEFAULTS.ttl,
      });
    } catch {
      // Best-effort: a missing record (already gone) must not surface — cleanup
      // runs after an order completes OR fails, and must never mask the cause.
    }
  }

  private async waitInSync(changeId: string): Promise<void> {
    const sleep =
      this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? (() => Date.now());
    const deadline = now() + (this.opts.maxWaitMs ?? DEFAULTS.maxWaitMs);
    const interval = this.opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    for (;;) {
      const status = await this.opts.client.getChangeStatus(changeId);
      if (status === 'INSYNC') return;
      if (now() >= deadline) {
        throw new Error(
          `route53: change ${changeId} did not reach INSYNC before timeout`,
        );
      }
      await sleep(interval);
    }
  }
}

/** Minimal structural view of the AWS SDK pieces we use (optional dep). */
interface AwsRoute53Sdk {
  Route53Client: new (cfg: { region?: string }) => {
    send(command: unknown): Promise<unknown>;
  };
  ChangeResourceRecordSetsCommand: new (input: unknown) => unknown;
  GetChangeCommand: new (input: unknown) => unknown;
}

/**
 * Build a {@link Route53Client} backed by the OPTIONAL `@aws-sdk/client-route-53`,
 * loaded lazily so it's only required when `--acme-dns-provider route53` is used.
 * A non-literal specifier keeps the optional dep out of the type graph (the base
 * install needs no AWS SDK). Credentials/region resolve via the standard AWS chain
 * (`AWS_*` env or instance role).
 */
export async function createRoute53Client(
  opts: { region?: string } = {},
): Promise<Route53Client> {
  const specifier = '@aws-sdk/client-route-53';
  let sdk: AwsRoute53Sdk;
  try {
    sdk = (await import(specifier)) as unknown as AwsRoute53Sdk;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /client-route-53/.test(String((err as Error).message))
    ) {
      throw new Error(
        'route53 DNS provider needs the optional @aws-sdk/client-route-53 ' +
          'dependency — run: npm install @aws-sdk/client-route-53',
      );
    }
    throw err;
  }
  const client = new sdk.Route53Client(
    opts.region ? { region: opts.region } : {},
  );
  return {
    async changeTxtRecord({ hostedZoneId, action, name, value, ttl }) {
      const res = (await client.send(
        new sdk.ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            Changes: [
              {
                Action: action,
                ResourceRecordSet: {
                  Name: name,
                  Type: 'TXT',
                  TTL: ttl,
                  // Route53 requires TXT values double-quoted.
                  ResourceRecords: [{ Value: `"${value}"` }],
                },
              },
            ],
          },
        }),
      )) as { ChangeInfo?: { Id?: string } };
      return { changeId: res.ChangeInfo?.Id ?? '' };
    },
    async getChangeStatus(changeId) {
      const res = (await client.send(
        new sdk.GetChangeCommand({ Id: changeId }),
      )) as { ChangeInfo?: { Status?: string } };
      return res.ChangeInfo?.Status === 'INSYNC' ? 'INSYNC' : 'PENDING';
    },
  };
}
