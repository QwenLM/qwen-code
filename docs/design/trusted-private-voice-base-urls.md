# Trusted private voice base URLs

## Status

Implemented for [#8286](https://github.com/QwenLM/qwen-code/issues/8286).

## Problem

Voice transcription rejects non-loopback HTTP endpoints and endpoints that resolve to private addresses. Those checks are safe defaults, but they also prevent managed deployments from routing ASR traffic through an isolated private gateway. Gateway URLs are deployment-specific, so vendor or region hostname lists would not scale.

## Design

Add `security.allowedInsecureVoiceBaseUrls`, an empty-by-default list of complete base URLs. Every entry must include an explicit `http://` or `https://` scheme and the full provider path. A configured voice provider receives the exception only when its normalized base URL exactly matches a list entry, including scheme, host, port, and path; URL serialization and trailing slashes are normalized, but missing schemes or path segments such as `/v1` are not inferred for custom or regional gateways. The pre-existing `/v1` inference is preserved, for provider entries, only for official DashScope compatible-mode endpoints; desktop OAuth- and environment-derived base URLs still pass through the same legacy inference for any host before matching. The CLI voice resolver performs no `/v1` inference at all, so a DashScope provider entry meant to resolve identically on both surfaces must carry the `/v1`-suffixed baseUrl; without it the CLI resolves the pre-`/v1` URL while desktop appends `/v1`, and each surface's allowlist entry must match its own resolved URL. Wildcards and hostname suffix matching are not supported.

The setting is trusted configuration. User, System, and SystemDefaults scopes may provide it; Workspace values are ignored and reported as a settings warning. This prevents a cloned repository from granting itself access to an insecure or private endpoint. Settings values pass through environment-variable interpolation before matching, so anything that controls the process environment can supply an interpolated allowlist entry or provider `baseUrl`; treat the process environment as part of the trusted configuration surface.

The exact-match result travels with the resolved voice configuration so every egress path applies the same decision:

- CLI batch transcription
- CLI and daemon streaming transcription
- Desktop batch and streaming transcription

An exact match permits cleartext transport and private RFC 1918, CGNAT, or IPv6 unique-local addresses. Loopback aliases, unspecified addresses, link-local ranges, and known cloud metadata addresses remain blocked. Explicit localhost behavior remains unchanged.

Streaming transports derive their WebSocket URL from the resolved base URL (`deriveWebSocketBase` drops a trailing `/v1` or `/compatible-mode/v1` and appends `/api-ws/v1/inference` or `/api-ws/v1/realtime`), so the wire path intentionally differs from the allowlisted path. The exact-match guarantee therefore covers the provider endpoint; the batch request path uses it verbatim, while the streaming wire path is derived from it rather than matched against the allowlist.

Desktop voice merges SystemDefaults, User, and System settings with the same trusted-scope precedence as the CLI; `modelProviders` deep-merges per provider-group key exactly like the CLI (the higher scope's array wins for the same key; disjoint keys all survive). It never reads Workspace settings for this exception. It resolves the selected voice model before credentials; same-ID provider entries are ambiguous unless they are exact `(id, baseUrl)` duplicates (where the first registered entry wins like the CLI model registry; `envKey` is not part of the composite key, so a differing `envKey` also keeps the first registration) or none of the matching entries needs a network-policy decision (in which case the whole set keeps the legacy fall-through, like a single public HTTPS entry), preventing an unrelated model or region from supplying the endpoint and API key. Public HTTPS providers do not require an insecure allowlist entry; cleartext or private-network providers still require an exact match.

Provider-group visibility intentionally differs between the surfaces in one narrow way. The CLI resolves voice models through the model registry, so entries in a custom provider group are only visible when the group id resolves to a protocol — a built-in group id or a `providerProtocol` mapping, exactly as in the rest of the CLI model surface. The desktop resolver reads trusted settings directly and scans provider entries across all groups, protocol-agnostic, because it has no model registry. A voice entry under a custom group without a `providerProtocol` mapping therefore resolves on desktop while the CLI reports it as not configured. The scan also admits entries the CLI registry filters out — voice entries under non-OpenAI protocol groups (for example `gemini`), `imageOnly` entries, and `qwen-oauth` groups resolve on desktop while the CLI rejects or never registers them — and it widens the ambiguity check: a same-ID entry with a differing baseUrl in any scanned group makes the model ambiguous on desktop when any matching entry needs a network-policy decision, hard-failing dictation even when the duplicate sits in a group the CLI never sees and the CLI resolves the model normally; duplicates that all keep the legacy fall-through (public HTTPS, unallowlisted) fail on neither surface. Every resolution path stays network-policy-checked on both surfaces; these divergences change which entries resolve, never the checks applied to them.

## Configuration ownership

The operator that provisions a regional gateway owns the allowlist entry. Managed deployments should render the provider `baseUrl` and the allowlist entry from the same declarative endpoint value. Adding a region therefore requires no Qwen Code change and cannot drift into a hostname-wide exception. An allowlisted hostname is only as trustworthy as its DNS — a later DNS record change redirects the exception (and the provider credentials) wherever the name points. Prefer IP-literal entries when the gateway address is stable.

## Failure and rollback behavior

Malformed entries and non-matches fail closed. Removing the entry immediately restores the existing HTTPS/public-network requirement after settings reload or process restart.

Desktop treats a provider whose ID exactly matches the selected voice model as authoritative only when the entry needs a network-policy decision — its base URL is allowlisted, cleartext HTTP, a private-network address, or loopback. Those entries resolve before OAuth credentials so a managed gateway wins for OAuth-signed-in users, and they fail closed on duplicate matches, unsupported schemes, always-blocked addresses, a missing allowlist match, or an unresolved `envKey`, preventing an accidental fallback to a different provider or region. Public HTTPS entries keep the legacy fall-through (OAuth, then the shared DashScope provider, then environment credentials), preserving the pre-allowlist credential precedence for existing installs; entries too incomplete to classify (a missing or unparseable base URL) fall through the same way. An entry without `envKey` resolves without an API key, matching the CLI for keyless local or private gateways.

Hostnames whose DNS records resolve to loopback addresses (for example `asr.localtest.me` or `/etc/hosts` aliases for a local ASR server) are always blocked, with or without an allowlist entry; the CLI previously allowed such DNS results. To reach a local endpoint, configure an explicit loopback baseUrl such as `http://localhost`, `http://127.0.0.1`, or `http://[::1]`, which remains allowed.

Two more behavior changes relative to the pre-allowlist guard:

- CLI: a voice model `baseUrl` with embedded credentials (`https://user:pass@host/...`) is rejected instead of proceeding with the credentials stripped — userinfo can make the URL parser resolve an attacker-controlled host.
- Desktop: IPv4-mapped IPv6 literals such as `::ffff:127.0.0.1` are classified by their embedded IPv4 address and no longer bypass the loopback block; configure an explicit loopback spelling instead.

## Verification

- Preserve default rejection for non-localhost HTTP and private endpoints.
- Require allowlist entries to include an explicit scheme and full provider path on both CLI and Desktop.
- Accept two unrelated regional private gateway URLs only when the selected URL exactly matches an entry.
- Reject scheme, port, host, or path mismatches.
- Reject non-HTTP(S) URL schemes even when exactly listed.
- Ignore and warn about Workspace-scoped entries.
- Continue rejecting link-local and cloud metadata addresses, including AWS IMDS IPv6, after an exact match.
- Decode IPv4-mapped, IPv4-compatible, and well-known-prefix NAT64 IPv6 literals consistently so trusted private addresses are accepted while embedded loopback and metadata addresses remain blocked.
- Reject local-use NAT64, IETF protocol-assignment/Teredo, and 6to4 transition prefixes on both trusted and default-deny paths.
- Match Desktop credentials to one unambiguous provider with the selected voice model ID.
- Exercise both CLI and Desktop resolution and DNS guard paths.
