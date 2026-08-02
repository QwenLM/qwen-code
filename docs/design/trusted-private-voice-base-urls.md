# Trusted private voice base URLs

## Status

Proposed for [#8286](https://github.com/QwenLM/qwen-code/issues/8286).

## Problem

Voice transcription rejects non-loopback HTTP endpoints and endpoints that resolve to private addresses. Those checks are safe defaults, but they also prevent managed deployments from routing ASR traffic through an isolated private gateway. Gateway URLs are deployment-specific, so vendor or region hostname lists would not scale.

## Design

Add `security.allowedInsecureVoiceBaseUrls`, an empty-by-default list of complete base URLs. Every entry must include an explicit `http://` or `https://` scheme and the full provider path. A configured voice provider receives the exception only when its normalized base URL exactly matches a list entry, including scheme, host, port, and path; URL serialization and trailing slashes are normalized, but missing schemes or path segments such as `/v1` are not inferred for custom or regional gateways. The pre-existing `/v1` inference is preserved only for official DashScope compatible-mode endpoints. Wildcards and hostname suffix matching are not supported.

The setting is trusted configuration. User, System, and SystemDefaults scopes may provide it; Workspace values are ignored and reported as a settings warning. This prevents a cloned repository from granting itself access to an insecure or private endpoint.

The exact-match result travels with the resolved voice configuration so every egress path applies the same decision:

- CLI batch transcription
- CLI and daemon streaming transcription
- Desktop batch and streaming transcription

An exact match permits cleartext transport and private RFC 1918, CGNAT, or IPv6 unique-local addresses. Loopback aliases, unspecified addresses, link-local ranges, and known cloud metadata addresses remain blocked. Explicit localhost behavior remains unchanged.

Desktop voice merges SystemDefaults, User, and System settings with the same trusted-scope precedence as the CLI; it never reads Workspace settings for this exception. It resolves the selected voice model before credentials and accepts exactly one provider entry with the same model ID, preventing an unrelated model or region from supplying the endpoint and API key. Public HTTPS providers do not require an insecure allowlist entry; cleartext or private-network providers still require an exact match.

## Configuration ownership

The operator that provisions a regional gateway owns the allowlist entry. Managed deployments should render the provider `baseUrl` and the allowlist entry from the same declarative endpoint value. Adding a region therefore requires no Qwen Code change and cannot drift into a hostname-wide exception.

## Failure and rollback behavior

Malformed entries and non-matches fail closed. Removing the entry immediately restores the existing HTTPS/public-network requirement after settings reload or process restart.

Desktop now treats a provider whose ID exactly matches the selected voice model as authoritative. Duplicate providers, a provider without a complete explicit base URL, an incomplete provider, or an unresolved provider key fail instead of silently falling back to environment credentials. Operators with such an existing entry must either complete it or remove it so the legacy DashScope/environment fallback can apply. This fail-closed behavior prevents an accidental fallback to a different provider or region.

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
