# Trusted private voice base URLs

## Status

Proposed for [#8286](https://github.com/QwenLM/qwen-code/issues/8286).

## Problem

Voice transcription rejects non-loopback HTTP endpoints and endpoints that resolve to private addresses. Those checks are safe defaults, but they also prevent managed deployments from routing ASR traffic through an isolated private gateway. Gateway URLs are deployment-specific, so vendor or region hostname lists would not scale.

## Design

Add `security.allowedInsecureVoiceBaseUrls`, an empty-by-default list of complete base URLs. A configured voice provider receives the exception only when its normalized base URL exactly matches a list entry, including scheme, host, port, and path. Wildcards and hostname suffix matching are not supported.

The setting is trusted configuration. User, System, and SystemDefaults scopes may provide it; Workspace values are ignored and reported as a settings warning. This prevents a cloned repository from granting itself access to an insecure or private endpoint.

The exact-match result travels with the resolved voice configuration so every egress path applies the same decision:

- CLI batch transcription
- CLI and daemon streaming transcription
- Desktop batch and streaming transcription

An exact match permits cleartext transport and private RFC 1918, CGNAT, or IPv6 unique-local addresses. Loopback aliases, unspecified addresses, link-local ranges, and known cloud metadata addresses remain blocked. Explicit localhost behavior remains unchanged.

Desktop voice merges SystemDefaults, User, and System settings with the same trusted-scope precedence as the CLI; it never reads Workspace settings for this exception. It resolves the selected voice model before credentials and accepts exactly one provider entry with the same model ID. A non-DashScope provider can be selected only when its base URL is present in the exact allowlist, preventing an unrelated model or region from supplying the endpoint and API key.

## Configuration ownership

The operator that provisions a regional gateway owns the allowlist entry. Managed deployments should render the provider `baseUrl` and the allowlist entry from the same declarative endpoint value. Adding a region therefore requires no Qwen Code change and cannot drift into a hostname-wide exception.

## Failure and rollback behavior

Malformed entries and non-matches fail closed. Removing the entry immediately restores the existing HTTPS/public-network requirement after settings reload or process restart. There is no migration because the default list is empty and existing settings retain their behavior.

## Verification

- Preserve default rejection for non-localhost HTTP and private endpoints.
- Accept two unrelated regional private gateway URLs only when the selected URL exactly matches an entry.
- Reject scheme, port, host, or path mismatches.
- Reject non-HTTP(S) URL schemes even when exactly listed.
- Ignore and warn about Workspace-scoped entries.
- Continue rejecting link-local and cloud metadata addresses, including AWS IMDS IPv6, after an exact match.
- Match Desktop credentials to one unambiguous provider with the selected voice model ID.
- Exercise both CLI and Desktop resolution and DNS guard paths.
