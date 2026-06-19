/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DNS-01 challenge solver abstraction. ACME proves domain control by checking a
 * TXT record at `_acme-challenge.<domain>` whose value is
 * `base64url(sha256(keyAuthorization))`. A provider creates that record
 * (`present`), the ACME flow waits for propagation and lets the CA validate, then
 * `cleanup` removes it. Implementations are thin wrappers over a DNS host's API
 * (Route53, Cloudflare) and hold NO ACME logic — so they're swappable and each is
 * unit-testable against a fake transport.
 */

/** The TXT record a DNS-01 challenge requires. */
export interface DnsChallengeRecord {
  /** FQDN of the TXT record, e.g. `_acme-challenge.qwen.example.com`. */
  readonly fqdn: string;
  /** TXT value: `base64url(sha256(keyAuthorization))`. */
  readonly value: string;
}

/**
 * Opaque handle returned by {@link DnsProvider.present} and passed back to
 * {@link DnsProvider.cleanup}. Carries the record identity plus any
 * provider-specific bookkeeping (zone id, record id, change id) needed to delete
 * exactly what was created.
 */
export interface DnsChallengeHandle extends DnsChallengeRecord {
  readonly [key: string]: unknown;
}

export interface DnsProvider {
  /** Stable provider name; matches the `--acme-dns-provider` value. */
  readonly name: string;
  /**
   * Create the challenge TXT record and resolve once it is set — and, where the
   * provider can confirm it, propagated/consistent — so the caller may ask the CA
   * to validate. Returns a handle for {@link cleanup}.
   */
  present(record: DnsChallengeRecord): Promise<DnsChallengeHandle>;
  /**
   * Remove the challenge TXT record. Best-effort and idempotent: must resolve (not
   * throw) when the record is already gone, so a cleanup after a failed order
   * never masks the original error.
   */
  cleanup(handle: DnsChallengeHandle): Promise<void>;
}
