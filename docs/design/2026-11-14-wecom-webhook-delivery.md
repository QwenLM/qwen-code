# WeCom group-webhook delivery

[English](2026-11-14-wecom-webhook-delivery.md) | [简体中文](2026-11-14-wecom-webhook-delivery.zh-CN.md)

## Status and scope

Design for [#17215](https://github.com/QwenLM/qwen-code/issues/17215), checked
against main `114694062b83f69093a936a3caea4c35bdbeb41d` and official WeCom
documentation on 2026-11-14. Implementation verification is recorded separately;
this document does not claim a real WeCom send.

Extend the existing [outbound Channel design](2026-11-10-outbound-webhook-channels.md)
in two PRs: adapter/registration first, shared Web configuration second. Both
remain Draft until their follow-up review. No new public delivery contract is
required.

## Problem and existing behavior

Qwen Code supports WeCom intelligent robots through Bot ID/Secret and WebSocket,
and self-built applications through the separate WeCom Callback integration.
Neither accepts a group Message Push URL. DingTalk and Feishu already expose
send-only webhook plugins with configured targets, secret editing, workspace
ownership and shared Web controls.

Users who only need scheduled results in an internal group should be able to
configure that group's URL without application credentials, a public inbound
server, observed contacts or a manually entered chat ID. Uptime Kuma and Apprise
both implement DingTalk, Feishu and WeCom group webhook senders; their current
WeCom text implementations establish feature parity, not the Markdown protocol
or error-handling policy for this adapter.

## Goals and boundaries

Provide a named `wecom-webhook` Channel, local start/stop readiness, readable
Markdown results and the existing configured-target delivery flow. Preserve
WeCom intelligent robots, the independent Callback entry, old task targets and
the existing manual-trigger/per-run delivery semantics.

Exclude inbound events, configurable mentions, member lookup, media uploads,
interactive cards, automatic retries, queues, splitting, a test-send UI/API,
Generic Webhook and new task lifecycle events. Do not reorganize unrelated
Channel entries or introduce a general notification framework.

## Backend and configuration

Export `webhookPlugin` and the adapter from the existing WeCom package, keeping
its conversational and callback exports intact. Register the additional built-in
type through the same loader pattern as DingTalk and Feishu. Declare Undici as a
direct dependency for the existing proxy transport pattern.

The plugin declares `outboundOnly: true`, a required sensitive `webhookUrl` and
`defaultDeliveryTarget` of `chat/default` labelled `Configured group`. Reuse
existing environment references, redacted readback and preserve/replace behavior.
Management validation may accept a valid environment reference; connection
validates the resolved URL. Reject an empty required URL.

Allow HTTPS on `qyapi.weixin.qq.com` at `/cgi-bin/webhook/send` with exactly one
nonempty `key` parameter. Reject credentials, fragments, custom ports, other
parameters, encoded/normalized path surprises and unsupported hosts. Accept a
single URL-unreserved credential value (letters, digits, `-`, `.`, `_`, `~`);
this is a conservative local validation policy, not a claim about every possible
future platform key. Do not add signing-secret fields: the URL key is the
credential. Do not follow redirects. A configured workspace proxy is the
supported transport override.

One Channel owns one URL. Tasks retain the existing logical destination rather
than credentials; changing the URL affects future sends through that Channel.
Accept only the adapter's own group target with chat ID and sender ID
`default`, and no thread. Reject arbitrary recipients, conversational loop
targets and inbound webhook-task execution targets. Explicit Notify,
prompt-result and supported persistent-scheduled delivery reuse the current
Channel boundary without creating a conversational agent session.

## Payload, content limits and mentions

Send one JSON payload with `msgtype: "markdown_v2"` and
`markdown_v2: { content: text }`. Preserve the input text; no formatter,
additional title, mention conversion or fallback message is needed. Ordinary
text is valid in this format. The official subset includes headings, emphasis,
lists, links, quotes, code and tables; it is not a promise of complete GFM.

Measure the actual content string with `Buffer.byteLength(text, "utf8")`.
Accept up to **4096 bytes** and reject larger content before network I/O. This
is a content-byte limit, not a serialized-JSON limit. Test ASCII, Chinese, emoji
and JSON-escaping-heavy content at and above the boundary. Retain the existing
shared delivery bound. Do not silently truncate, split or issue a fallback
request.

Unlike the older text/markdown formats, `markdown_v2` does not support
`<@userid>`, `<@all>` or font-colour syntax. Send no mention arrays and do not
convert task text into mentions. Unit tests prove the payload and preservation;
real-client rendering and absence of mention notifications remain live smoke
checks. Clients before 4.1.36 (Android before 4.1.38) display plain text.

## Transport, failures and lifecycle

Follow the reviewed Feishu/DingTalk transport pattern without refactoring those
adapters or adding a shared framework. One attempt makes at most one request,
using a **15-second timeout**, **16,384-byte response limit** and a request-owned
Undici dispatcher when a workspace proxy is configured. Honor existing
`NO_PROXY` behavior without replacing the global dispatcher.

Success requires an HTTP-success response containing an object with a numeric
safe-integer `errcode === 0`. Missing/string codes, arrays, malformed JSON and
oversized response bodies cannot report success. Never expose the remote
`errmsg`, raw response, URL key or arbitrary thrown message.

Reuse `ChannelProactiveDeliveryError` and existing result propagation:

| Failure                                                               | Disposition                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------ |
| HTTP 408, 425, 429 or 5xx                                             | Transient                                              |
| Other non-success HTTP                                                | Permanent                                              |
| WeCom -1, 45009 or 45033                                              | Transient: system busy, frequency or concurrency limit |
| Other nonzero WeCom code                                              | Permanent                                              |
| Network, rejected redirect, invalid response, timeout or cancellation | Transient; never automatically retried                 |
| Invalid target, not ready or oversized content                        | Permanent                                              |

The documented sending rate is **20 messages/minute per webhook**. Surface
throttling without adding a local queue. API acceptance does not establish
recipient delivery or reading, and a timeout/cancellation can occur after the
remote endpoint accepted a request.

Connect validates local configuration and creates no remote test message.
Disconnect clears readiness, aborts all in-flight requests and exposes a drain
promise. Lifecycle generations prevent an earlier connect from restoring
readiness after a stop. Reconnect waits for draining; each request clears its
timer and releases reader/dispatcher resources independently.

## Shared Web integration

Group `wecom` and `wecom-webhook` under WeCom, with accurate method labels
`Intelligent bot` and `Webhook sending`. Keep `wecom-callback` as its existing
independent entry. Reuse the current platform helper, localized labels,
credential controls, outbound-only settings visibility and configured-target
picker; no new SDK or daemon route is needed.

The webhook editor has a required secret URL and no signing-secret field.
Create/edit/preserve/replace and required-field validation must remain correct.
The same controls serve `qwen serve` and `WebShellWithProviders` when the host
enables the pages and supplies a daemon workspace. Cover an existing intelligent
bot and independent Callback entry as regressions.

## Files and delivery sequence

Backend changes are limited to the WeCom adapter/plugin and tests, its dependency
manifest/lockfile, built-in registry/tests, this bilingual design, the user guide
and documentation navigation. Web changes cover platform grouping, labels,
existing editor/picker regression tests, browser scenarios and a Web section in
the user guide. Preserve the package boundary and existing ownership checks.

The backend PR references #17215 without closing it; the Web PR depends on that
backend and completes the issue after both land. Both start as Draft. The Web
branch includes the backend for local end-to-end testing.

## Validation and open evidence

Before implementation, record the missing built-in/Web mode against the baseline.
If a global CLI is unavailable, explicitly record a built-artifact/source
fallback. Run focused package tests, build, typecheck, bundle and formatting/lint
for changed files. Exercise URL validation, environment references, secret
redaction, exact byte bounds, business/HTTP errors, cancellation/concurrency,
proxy/bypass and unchanged existing WeCom behavior.

Use a local daemon/worker with a fake model and an HTTPS mock behind a local
CONNECT proxy to verify configured-target scheduled delivery and failures
without sending to a real group. Verify Web create/edit/start/stop and scheduled
target flows in a browser, including a non-primary workspace and narrow viewport.
Mocks establish our integration behavior, not real-platform rendering.

Live WeCom validation requires a permitted internal group and Message Push URL.
The official setup guide describes internal-group and administrator controls;
it does not establish a universal certification requirement or exemption.
Availability of a personal testing account affects E2E scheduling, not whether
the feature can be proposed or implemented. Real-client Markdown/mention
rendering and live credentials remain explicitly pending until tested.

## References

- [Message Push protocol](https://developer.work.weixin.qq.com/document/path/91770)
- [Setup and creation conditions](https://open.work.weixin.qq.com/help2/pc/14931)
- [Global error codes](https://developer.work.weixin.qq.com/document/path/90313)
- [Uptime Kuma WeCom sender](https://github.com/louislam/uptime-kuma/blob/4f6661cfa83a06be0353d5536ef3d9ee0064f534/server/notification-providers/wecom.js)
- [Apprise WeCom bot sender](https://github.com/caronc/apprise/blob/c6f76f3599ec9bc1591abfd4fc8c27a5124f88fa/apprise/plugins/wecombot.py)
- [Send-error coordination #7521](https://github.com/QwenLM/qwen-code/issues/7521)
