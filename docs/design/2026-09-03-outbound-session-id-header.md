# Outbound `session_id` Header

## Summary

Qwen Code attaches its current session ID as the `session_id` HTTP header only when the outbound LLM request hostname is one of the three Routify endpoints documented by ModelRouter: `routify.alibaba-inc.com`, `routify-online.alibaba-inc.com`, or `routify-pub.alibaba-inc.com`.

That built-in allowlist is fixed and not configurable: Qwen Code does not attach the header to subdomains, other `alibaba-inc.com` hosts, or non-Routify providers, and no setting can add to, remove from, or disable it.

Since the `outboundCorrelation.sessionIdHeader` follow-up, an **opt-in second branch** can additionally send the session ID to hosts the user lists themselves, under a header name they choose — see [User-configurable hosts](#user-configurable-hosts) below. It ships off with an empty allowlist and is deliberately independent of the built-in branch.

Standard fetch redirect behavior applies after the initial destination check, so a listed host can forward the header by redirecting the request.

## Motivation

Routify's ModelRouter accepts `session_id` as a session-affinity and traffic-marking value. Qwen Code already maintains a session ID, but it is currently local metadata and never reaches the ModelRouter request. Reusing it gives Routify one stable affinity value per CLI session without creating another identifier.

## Security boundary

A session ID is a stable cross-request identifier. The implementation therefore requires HTTPS and compares the parsed request hostname to an exact-match allowlist — the fixed set of three ModelRouter hostnames for the built-in branch, plus whatever the user listed for the opt-in branch. Neither branch uses suffix matching, wildcards, or path matching. Invalid URLs fail closed.

The Qwen Code session ID replaces any custom `session_id` value on an eligible request so the affinity marker cannot disagree with the active session. All other existing headers, including authorization, are preserved.

## User-configurable hosts

`outboundCorrelation.sessionIdHeader` lets a user send the same session ID to a
gateway of their own, because some gateways require a stable per-conversation
identifier under a name of their choosing (OpenCode Go rejects requests without
`x-opencode-session`). `outboundCorrelation.customHeaders` cannot express this:
it is baked into the SDK client at construction, while `/new` and `/resume`
rotate the session ID without rebuilding that client.

```json
{
  "outboundCorrelation": {
    "sessionIdHeader": {
      "enabled": true,
      "headerName": "x-opencode-session",
      "trustedHosts": ["opencode.ai"]
    }
  }
}
```

Rails, in the order they are applied:

- **Off by default, with an empty allowlist.** `enabled: true` with no
  `trustedHosts` sends nothing; there is no default allowlist to inherit.
- **HTTPS and exact host only**, matched case-insensitively against the parsed
  hostname. The port is not part of the comparison, and internationalized names
  must be listed in punycode.
- **Header name validated** against a conservative HTTP token subset
  (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`), which is what keeps CRLF out of the name.
  An invalid name drops this branch only, warning once per distinct name.
- **The flag is re-checked at the send site** as `enabled === true`, so a
  settings object that arrives without the field is treated as off.

The two branches are independent by construction. The built-in branch resolves
without consulting any setting, and the opt-in branch is resolved by a helper
that cannot throw — a `Config` collaborator lacking
`getOutboundSessionIdHeaderSettings()` yields "no configured header", never an
error that would suppress the first-party header. That independence is the
property to preserve when editing this seam: a setting that ships off must not
be able to alter a path that ships on.

When one host matches both branches, both headers are sent with the same value,
unless the configured name differs from `session_id` only by case — header names
are case-insensitive on the wire, so that is emitted once.

## Threat model

**Recipients.** Without configuration, exactly the three ModelRouter hosts.
With configuration, those plus the hosts the user listed. There is no path by
which any other host receives the header from the initial request.

**De-anonymization window.** The session ID is stable for the life of a session
and rotates on `/new` and `/resume`. Every recipient can therefore group all
requests of one conversation, and correlate them with anything else it knows
about the connection (API key, account, source IP). It is not a global user
identifier and does not persist across sessions, so the window is one
conversation per recipient — which is why the guidance is to list only hosts
that already receive the prompt content itself.

**Redirects.** Both allowlists are checked against the initial destination.
`fetch` strips `Authorization` on a cross-origin redirect but not arbitrary
headers, so a listed host that redirects can forward the session ID to a host
the user never listed. Listing a host is therefore trust in that host's
redirect behavior too, not only in the host itself.

**Misconfiguration.** A user can list a host they do not actually trust. The
defaults (off, empty list) mean this requires a deliberate edit, and the setting
is flagged security-relevant in `docs/users/configuration/settings.md`. A typo
in `headerName` is only visible as an `OUTBOUND_CORRELATION` warning in the
debug log (`QWEN_DEBUG_LOG_FILE=1`), so the
observable symptom is a gateway that keeps rejecting requests; that is a known
rough edge rather than a safety issue, since the failure direction is "not
sent".

**Per-request identifiers.** A per-request UUID would remove the grouping
ability, but also the session affinity and prompt-cache routing that are the
entire point of the header. It is out of scope here and remains available as a
separate setting if a recipient ever needs correlation without grouping.

## Request lifecycle

OpenAI-compatible and Anthropic clients receive a fetch wrapper. The wrapper reads `Config.getSessionId()` immediately before each HTTP request. This matters because `/clear` starts a new session without rebuilding the SDK client.

Gemini requests use the SDK's request-level `httpOptions.headers`. The header is rebuilt for generate, streaming generate, and embedding requests. Gemini injection requires an explicit Routify `baseUrl`; implicit SDK endpoints remain unchanged.

## Provider coverage

- The default OpenAI-compatible provider covers Routify's OpenAI protocol and subclasses that inherit its client construction.
- DashScope has a separate client constructor and is integrated explicitly.
- Anthropic uses the same per-request fetch wrapper.
- Gemini and Vertex use request-level HTTP options when the base URL points to Routify.

Non-LLM traffic, other domains, MCP requests, tool fetches, subprocesses, `traceparent`, request IDs, and body metadata are out of scope.

## Verification

Unit tests cover exact-host and HTTPS matching, rejection of lookalike hosts, invalid URLs, preservation and precedence of combined `Request` and init headers, empty values, session rotation, and the shared runtime-fetch wrapper. For the opt-in branch they additionally cover the default-off and empty-allowlist cases, an absent `enabled` field, plaintext and suffix-lookalike hosts, CRLF and other invalid header names, coexistence with the built-in branch, the case-only-difference collapse, and a `Config` without the settings getter still producing the built-in header. Provider tests verify the OpenAI-compatible construction paths install a working correlation layer, and Gemini tests cover constructor destinations, generation, embedding, and successive requests observing a changed session ID.
