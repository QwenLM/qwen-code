# WeCom Self-Built Application Callback Channel

[English](wecom-callback.md) | [简体中文](wecom-callback.zh-CN.md)

## Problem and scope

The existing `wecom` channel connects intelligent robots with a Bot ID and
Secret over WebSocket. Enterprise self-built applications instead deliver
encrypted XML to an HTTP callback and require enterprise/application credentials
to send replies. Those applications cannot currently connect to Qwen Code.

Add a `wecom-callback` channel for text direct messages, with one enterprise
self-built application per named channel. Multiple applications use separate
channel configurations and listening ports. Media, group chats, application
events, streaming replies, multi-application routing within one listener, and
durable inbound/outbound delivery are outside this change.

## Design

Export a separate `callbackPlugin` from `@qwen-code/channel-wecom`. Register it
explicitly in the CLI registry and expose its configuration descriptors in Web
Shell. Keep the existing `wecom` plugin and credentials unchanged. A separate
type avoids conditional required fields and does not need a new package or
changes to the shared channel runtime.

Configuration requires `corpId`, `agentId`, `corpSecret`, `token`, and
`encodingAESKey`. Credentials support environment-variable references. Mark the
three secret fields as secret descriptors so the existing settings service
redacts and preserves them correctly. `webhookHost` defaults to `127.0.0.1` and
`webhookPort` to `8645`; the fixed endpoint is `/wecom/callback`. Deployments
publish that endpoint through their own HTTPS reverse proxy or tunnel.

Each adapter owns its HTTP listener in the owning channel worker. No daemon
route or process-global listener is added. Listen failures fail channel startup;
disconnect closes connections and prevents further inbound dispatch or outbound
API work from that adapter instance.

For GET verification, validate the SHA-1 signature, decrypt `echostr`, validate
the receiver Corp ID, and return the exact plaintext. For POST, bound request
size, verify the signature before decryption, validate PKCS#7 padding, framing,
receiver Corp ID, XML recipient and Agent ID. Use `saxes` to parse flat XML,
rejecting DTDs, duplicate fields and nested structures. Use Node crypto for the
protocol's AES-256-CBC framing and constant-time signature comparison. Accept
only recent signed requests to bound replay; maintain a bounded in-memory
message-ID cache to deduplicate platform retries during the same process. Only
admitted senders reserve entries, retained for at least five minutes and until
the signed request's timestamp window expires, including positive clock skew.

Authenticated text messages become direct-message envelopes and enter
`ChannelBase.handleInbound`, preserving existing access policies, pairing,
commands, permissions and session routing. Acknowledge valid callbacks before
agent execution completes. Unsupported message types and lifecycle events are
acknowledged without starting a task. Reply recipients must be a single user;
reject broadcast and multi-recipient identifiers.

Send text through the fixed WeCom `message/send` API. Cache application access
tokens with a shared refresh promise; refresh and retry once when the platform
explicitly rejects an expired token. Bound API requests with timeouts and abort
them on disconnect. Report sanitized errors without API URLs or credentials.
Split replies at Unicode boundaries so each message is at most 2048 UTF-8 bytes.
Proactive delivery, when requested by the shared runtime, supports direct users
only, without groups or threads.

## Affected components

- `packages/channels/wecom`: callback plugin, configuration, protocol parsing,
  crypto, HTTP listener, outbound application API, and collocated tests.
- `packages/cli/src/commands/channel`: explicit built-in registration and tests.
- `packages/web-shell/client/components/channels`: platform availability and
  regression tests using the shared descriptor-driven editor.
- User channel documentation, navigation, and the workspace lockfile for the
  existing pinned `saxes` dependency.

The shared factory, standalone ACP service, daemon workers, settings store,
catalog endpoint and Web Shell editor consume the plugin through their existing
contracts. No core protocol, SDK wire type or daemon ownership rule changes.

## Validation and acceptance

Use the official WeCom SDK's fixed encrypted sample as an independent known
answer, plus independently constructed encrypted messages. Unit/integration
tests run a real loopback callback server with a fake agent bridge and mocked
WeCom API responses. Verify handshake, early acknowledgement, one prompt per
message ID, access controls, recipient isolation, invalid authentication/XML,
body limits, token caching/refresh, byte-safe splitting and listener cleanup.
Run the existing intelligent-robot tests as regression coverage.

Record a global CLI baseline, then verify the local built CLI and protocol
harness. Run build, typecheck, bundle and focused tests. Perform two clean
self-audit passes and independent review. Keep exact commands and evidence in
`.qwen/e2e-tests/wecom-callback.md`.

Real-platform acceptance requires a WeCom administrator to configure a public
callback URL and app visibility/trusted outbound IPs, then test verification,
an allowed sender, a denied sender and a long Unicode reply. Offline tests do
not prove these tenant-specific settings. The PR must disclose any unperformed
real-platform checks. Process interruption after acknowledgement can lose an
in-flight task; persistent recovery is a separate change.

## Open questions

None blocking the scoped implementation. Live WeCom validation remains an
explicit reviewer step when no enterprise test application is available.
