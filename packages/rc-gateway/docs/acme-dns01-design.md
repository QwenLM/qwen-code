# Auto-ACME (Let's Encrypt, DNS-01) for the gateway

**Goal.** Let `qwen-rc serve` obtain and auto-renew a real Let's Encrypt cert for a
configured domain via the **DNS-01** challenge, so a non-loopback bind has valid
TLS with zero manual cert handling. Targets self-hosted / home-server deploys
(pkix behind residential NAT): DNS-01 needs **no inbound ports** and supports
**wildcards**, unlike HTTP-01.

Today the gateway already terminates TLS from operator-supplied cert files
(`--tls`/`--tls-key`, `bindSecurity.ts` → `mode:'tls'`) but reads them **once at
boot** into a static `https` server (`cli.ts`). Auto-ACME adds: cert acquisition,
a renewal scheduler, and **live cert reload** (renewal must not require a restart).

## CLI surface (new flags on `qwen-rc serve`)

- `--acme-domain <fqdn>` — cert subject; repeatable / comma-list for SAN; `*.x`
  wildcard allowed (DNS-01 only). Presence enables ACME mode.
- `--acme-email <email>` — ACME account contact (LE requires it).
- `--acme-dns-provider <name>` — e.g. `cloudflare`. Selects the `DnsProvider`.
- `--acme-staging` — use LE **staging** directory (default: production). Staging
  has loose rate limits — use it for first runs; prod issues browser-trusted certs.
- `--acme-directory <url>` — override the ACME directory URL (private CA / Pebble).
- **Provider credentials come from ENV ONLY** (e.g. `CLOUDFLARE_API_TOKEN`), never
  a flag — argv leaks via `ps`. The provider documents its env var(s).

`--acme-domain` implies a TLS story, so `bindSecurity` accepts a non-loopback bind
in a new `mode:'acme'` (cert is auto-obtained, not file-supplied). `--host` should
be the public / Tailscale interface the domain resolves to.

## Storage (`~/.qwen/rc/acme/`, dir 0700)

- `account.key` — ACME account private key (0600). Reused across renewals.
- `<primary-domain>/{cert.pem,privkey.pem,chain.pem,meta.json}` — issued bundle
  (0600). `meta.json` = `{ domains, notAfter, issuedAt }`.
- Never logged. Cert privkey + account key are the crown jewels.

## Components (each a TDD slice)

1. **`renewalSchedule.ts`** (pure) — `shouldRenew(notAfter, now, renewBeforeDays=30)`,
   `msUntilRenewal(notAfter, now, renewBeforeDays)` (with jitter floor). The
   "renew at ~30 days before 90-day expiry" policy, unit-tested.
2. **`certStore.ts`** (fs) — load/save the bundle + meta under the 0700 tree; report
   the current cert's `notAfter`. Tested against a tmp dir.
3. **`DnsProvider`** interface + registry — `present(fqdn, value) → handle`,
   `cleanup(handle)`. The challenge record is
   `_acme-challenge.<domain>` TXT = `base64url(sha256(keyAuthorization))`.
4. **`dnsProviders/{route53,cloudflare}.ts`** — concrete solvers. **Route53**
   first (the operator's own DNS): `ChangeResourceRecordSets` UPSERT/DELETE of the
   `_acme-challenge` TXT in the hosted zone, then poll `GetChange` until `INSYNC`.
   **Cloudflare** second: zone lookup + TXT create/delete via the v4 API. Each
   tested with a fake `fetch`/SDK boundary. Creds from env: Route53 via the
   standard AWS chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` or
   an instance role) + `AWS_ROUTE53_HOSTED_ZONE_ID`; Cloudflare via
   `CLOUDFLARE_API_TOKEN`.
5. **`acmeClient.ts`** — thin wrapper over the `acme-client` npm lib: load/create
   account from `account.key`, place an order for the domains, solve each DNS-01
   challenge via the `DnsProvider` (present → wait for propagation → notify ACME →
   cleanup), finalize with a fresh cert keypair, download the chain.
6. **`acmeManager.ts`** — orchestration: on start, load the bundle from the store;
   if absent or `shouldRenew`, obtain; schedule the next renewal on an **unref'd**
   timer; expose `currentSecureContext()` + an `onChange` hook. **Fail-safe:** a
   renewal error RETAINS the current cert, logs loudly, and retries with backoff —
   never crashes the gateway; never silently serves an expired cert.
7. **cli + bind integration** — `bindSecurity` `mode:'acme'`; the https server is
   built with an **`SNICallback`** (or swappable secure context) that reads the
   manager's live context, so a renewal swaps the cert with **zero downtime**.

## Security notes

- 0700 dir / 0600 keys; provider creds from env, not argv.
- Validate `--acme-domain` is a syntactic FQDN before any network call.
- Renewal is **fail-open on availability, fail-safe on security**: keep serving the
  valid current cert on transient failure; surface a hard warning as expiry nears.
- Default to **production** but document `--acme-staging` prominently (LE prod rate
  limits are easy to hit while iterating).

## Testing boundary

Unit-testable here: `renewalSchedule`, `certStore` (tmp dir), each `DnsProvider`
(fake `fetch`), and `acmeManager`'s state machine (MOCK `acmeClient` + fake
`DnsProvider` + fake `certStore`). **Not** testable here: real LE issuance — needs
a live domain + DNS API. On-box acceptance: issue against **LE staging** with the
real domain + provider token, confirm the cert lands + HTTPS serves, then switch to
prod and load `https://<domain>/ui/` from the phone.

## Slices

1. ✅ `renewalSchedule` (pure) + `certStore` (fs) + `DnsProvider` interface.
2. ✅ `dnsProviders/route53.ts` + `cloudflare.ts` — TDD with fake transports.
3. ✅ `acmeManager` (acquire/renew loop, timer-cap) + `acmeClient` (acme-client v5
   wrapper) + assembly (`buildAcmeStack`, `accountKeyStore`) +
   `scripts/acme-staging-test.mts`.
4. ✅ cli `--acme-*` flags + `bindSecurity` `mode:'acme'` + `acmeHttps`
   SNICallback live reload. (~120 unit tests across slices 1–4.)
5. ⏳ **On-box (needs a real domain):** LE-**staging** issuance via the harness →
   `--acme-staging` end-to-end → production → phone over HTTPS. Also: declare
   `acme-client` + `@aws-sdk/client-route-53` as `optionalDependencies`.
