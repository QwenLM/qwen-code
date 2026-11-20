# Generic outbound webhook delivery

[English](2026-11-16-generic-webhook-delivery.md) | [简体中文](2026-11-16-generic-webhook-delivery.zh-CN.md)

## Problem and current behavior

Issue #17374 extends the existing Channel delivery framework to HTTP receivers
controlled by developers. DingTalk, Feishu and WeCom already provide configured
outbound destinations. A generic receiver should be selectable through the same
scheduled-task, explicit-prompt and Notify flows, without a private adapter for
each service. OpenClaw's [automation delivery](https://docs.openclaw.ai/automation/cron-jobs/delivery)
provides a close product precedent; its finished-event schema is not adopted.

HTTP Stop hooks remain lifecycle extensions. Their coverage depends on execution
mode, and their responses can affect agent continuation. This feature concerns
named delivery destinations and does not change hooks or scheduling semantics.
The adapter receives a logical target and text, not task or session metadata.

## Scope and delivery split

The backend PR adds the private built-in `@qwen-code/channel-generic-webhook`
package, registration, shared network validation, protocol and integration tests,
and user documentation. A dependent Web PR adds the Generic Webhook entry,
translated configuration and destination wording in shared Web Shell, including
hosts using `WebShellWithProviders`.

No global enablement flag, new daemon endpoint, test-message button, inbound
webhook, template engine, arbitrary headers/methods, message URL override,
attachments, event subscription, retry queue or scheduling change is introduced.
Manual-run and per-run-session delivery restrictions remain unchanged.

## Configuration and public protocol

The plugin type is `generic-webhook`, with `outboundOnly: true` and the existing
logical destination `chat/default`. One named Channel owns one configured URL.
Only that destination, without a thread, is accepted. URL and credentials never
appear in the delivery target or task file. Changing configuration changes later
deliveries through the named Channel.

| Field                 | Behavior                                                                                |
| --------------------- | --------------------------------------------------------------------------------------- |
| `webhookUrl`          | Required secret, supports the existing `$ENV_VAR` syntax                                |
| `bearerToken`         | Optional secret and environment reference; sent as Bearer authorization                 |
| `allowPrivateNetwork` | Boolean, absent means false; permits the configured receiver on local/private addresses |

Management validates literal URLs and field/reference syntax synchronously. It
does not query DNS or send a message while saving. Runtime resolves environment
references before validating the actual configuration. Each send validates DNS
and binds the connection to a checked address. An environment reference is not
replaced by a fabricated provider URL. Existing secret preserve/replace/clear
and environment-reference persistence behavior is retained.

The sender uses POST with JSON content type and exactly this version-one shape:

```json
{ "version": 1, "text": "The supplied result, including Markdown." }
```

The text is preserved as supplied to the adapter. Receivers must validate the
version and tolerate future additional fields; incompatible changes require a
new version. No task ID, session ID, full transcript or stable deduplication key
is promised. The optional Bearer value must be a valid non-empty token suitable
for its header; errors never echo the token or URL.

Any HTTP 2xx, including bodyless 204, acknowledges endpoint acceptance. It does
not guarantee downstream processing. Response bodies are not interpreted as
business codes, agent instructions or replacement text. Once 2xx is observed,
response cleanup failure must not turn that acknowledged send into a failure.
HTTP 408/425/429/5xx and transport timeouts/failures are transient; other HTTP
failures and invalid configuration/targets are permanent. Classification does
not create an automatic retry. A lost response may follow a successful receipt.

## Address and transport rules

| Destination                                                  | Default      | `allowPrivateNetwork: true`         |
| ------------------------------------------------------------ | ------------ | ----------------------------------- |
| Public HTTPS                                                 | Allowed      | Allowed                             |
| Public HTTP                                                  | Rejected     | Rejected                            |
| Loopback/RFC1918/IPv6 ULA HTTP or HTTPS                      | Rejected     | Allowed for the configured endpoint |
| Unspecified, link-local, metadata and other reserved targets | Rejected     | Rejected                            |
| Redirect                                                     | Not followed | Not followed                        |

Local means the daemon/worker host or container. The private option expresses
network intent; it is not proof that only a human can edit configuration. Existing
workspace trust, management authorization and file modification controls remain
in force. There is no second confirmation flow, CIDR editor or hostname list.

URLs must be absolute HTTP(S), have no embedded credentials or fragment, and use
valid configuration syntax. All DNS answers are checked. HTTP additionally
requires every answer to be an allowed private/local address. HTTPS can use
public addresses or explicitly permitted private/local addresses. IPv4-mapped
IPv6 is classified by its embedded IPv4 address. The private exception does not
permit link-local/cloud metadata, including `fd00:ec2::254`, or CGNAT/reserved
ranges. A checked address is selected once for that send and used for the real
connection. TLS certificate and hostname verification remain enabled.

A small pure-Node `@qwen-code/network-policy` workspace owns the existing core
address validation and pinned resolution logic, extended with the private/local
policy. Core keeps its current public/undefined wrapper and return contract;
`ExtensionNetworkPolicy` is not broadened. This avoids coupling Channel packages
to private core or core to Channel lifecycle infrastructure. It is a shared
resolver, not a new HTTP framework. Existing public-policy consumers retain their
behavior and existing tests.

Core loads the shared resolver only when executing a public-policy request.
Importing core for settings-schema generation or other metadata tooling does not
load the additional workspace. The CLI bundler includes the deferred module in
its distributable output; automation artifact layouts and dependency-installation
workflows remain unchanged.

The adapter uses a request-owned Undici dispatcher. Direct and NO_PROXY routes
use the checked lookup. For a real proxy route, Undici's existing
`EnvHttpProxyAgent`/`ProxyAgent` handles the tunnel, proxy authentication and TLS;
its client factory changes only the CONNECT authority to the checked IP. The
origin URL, Host and TLS server name remain the configured hostname. The proxy
therefore does not independently resolve the origin hostname. Proxy settings are
not silently bypassed, and the process-wide dispatcher is not modified.

A local pre-implementation probe confirmed this public Undici API path for
HTTP/HTTPS receivers and HTTP/HTTPS proxies, original Host/SNI, certificate
hostname rejection, proxy authentication and NO_PROXY. This is a transport
feasibility result, not verification of the implemented Channel. Production
tests must exercise the real adapter and worker with the same guarantees.

## Bounds and lifecycle

The existing shared delivery limit is 100,000 UTF-16 code units. Worst-case JSON
escaping of that text plus the version-one envelope is 600,023 bytes. The adapter
allows at most 640 KiB (655,360 bytes) of serialized UTF-8 JSON, measured before
sending. It does not truncate or split again. This budget is independent of IM
provider limits.

Use a 15-second total request deadline covering resolution, connection and
response handling. Do not buffer an unused response body. Cancel/release it with
bounded cleanup and release the request-owned dispatcher. Disconnect aborts
in-flight operations and drains them; reconnect must not resurrect a cancelled
connection generation. Connect only validates local configuration and readies
the sender. It does not contact the receiver or verify remote authentication.

## Web behavior

Add one independent Generic Webhook platform entry using the existing editor,
secret controls and boolean field support. The private/local option belongs in
advanced settings. No inbound, pairing or agent-session controls are shown.
Configured targets use endpoint/destination wording. Keep the wire target as
`chat/default`; changing its label alone is insufficient because current task
UI selects group wording from the target type. The editor retains existing
platform group wording, saved/unavailable targets and older-daemon fallback.
Scheduled-task list cards display the Channel name and destination ID for every
target type, so they need no additional cross-workspace metadata fetch to avoid
describing a generic endpoint as a chat.

## Affected components

| Component                                 | Change                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Network-policy workspace and core wrapper | Shared checked/pinned resolution; preserve existing core public behavior  |
| Generic Channel package                   | Configuration, payload, lifecycle, proxy transport and descriptor         |
| Workspace/CLI registry/build references   | Include the two new private packages and register the built-in            |
| CLI integration tests                     | Environment and secret handling, actual worker delivery and authorization |
| Shared Web Shell                          | Entry, translated fields, private option and endpoint wording             |
| User documentation and receiver example   | Version-one protocol, network rules, acknowledgement and limits           |

## Verification and acceptance

The E2E plan is `.qwen/e2e-tests/generic-outbound-webhook.md`. The global `qwen`
binary was unavailable, so the pre-change runtime baseline used the preserved
WeCom Web build at `50eb3f9f`, explicitly recorded as a fallback. Its real daemon
omits Generic and rejects creation without persisting configuration or sending
network/model requests. Source inspection also confirms the gap at the new main
baseline `7f48cdeb`.

Verify configuration/env syntax, secret editing and sanitized failures; plain
text/Markdown/Unicode and worst-case escaping; 2xx/204, errors and no retries;
mixed DNS answers, special addresses, private opt-in and HTTP restrictions;
direct and proxy routing, Host/SNI/TLS/auth and NO_PROXY; redirects, cancellation,
disconnect/reconnect and finite cleanup. Exercise a real daemon and worker with
a local receiver, and supported scheduled delivery using a deterministic model
fixture. Do not claim a real external service/model test from these fixtures.

Verify Web creation/editing, advanced private option, credentials, task selection
and saved-target behavior in unit and browser tests. Build, typecheck, bundle,
run focused unit/integration tests and required build-metadata checks; complete
two clean self-audit passes and independent review before both Draft PRs.

## Decisions and remaining limits

The explicit per-Channel network policy does not require a global feature gate.
Proxy feasibility is settled by the local probe, with adapter/worker validation
required before delivery. Future
receiver requirements may justify other authentication or event fields; they are
not preloaded into this version.
