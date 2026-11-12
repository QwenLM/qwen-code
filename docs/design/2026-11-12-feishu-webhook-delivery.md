# Feishu custom-bot webhook delivery

[English](2026-11-12-feishu-webhook-delivery.md) | [简体中文](2026-11-12-feishu-webhook-delivery.zh-CN.md)

## Status and scope

This is the proposed design for [issue #16997](https://github.com/QwenLM/qwen-code/issues/16997),
checked against repository baseline `8a8fe0fc4ddc1189d489bf0d711a52f2ebb05723`
and current Feishu documentation on 2026-11-12. Implementation and validation
results are separate from this proposal. No live Feishu delivery is claimed.

The feature adds Feishu custom-bot outbound delivery and the small shared Web
integration needed to configure it. It extends the merged
[outbound webhook Channel design](2026-11-10-outbound-webhook-channels.md),
retaining the existing Channel delivery, configuration and lifecycle contracts.

Work is split into two sequential PRs: the backend adapter, registration and
protocol coverage first; shared Web configuration and interaction coverage
second. The second PR depends on the first. Both PRs serve the same issue.

## Problem and existing behavior

The existing Feishu application-bot Channel requires application credentials and
supports inbound communication. Its inbound webhook mode is a different
integration from posting a task result to a custom robot's configured group.
Users who need only outbound group messages should not need application
credentials, an inbound server, contact discovery or a manually entered chat ID.

DingTalk already provides a separate send-only webhook plugin, public
`outboundOnly` / `defaultDeliveryTarget` metadata, secret configuration fields and
a shared Web method picker. Notify, explicit prompt-result delivery and
persistent scheduled-result delivery use the same Channel delivery path.
ChannelBase checks ownership and delegates proactive sending to the adapter
without creating an agent session.

The Feishu package already builds Markdown cards for application-bot messages.
Its existing builder adds a preview summary and can add titles, streaming state,
collapsible panels and controls. Its application-bot transport serializes a card
into a tenant-authenticated message request and uses character-based splitting.
Those defaults and that transport do not define the custom-bot webhook protocol.

## Goals and boundaries

Provide a complete flow: choose Feishu and its webhook method, configure a named
Channel, save and start it, then select its configured group for scheduled task
delivery. Keep the existing Feishu application-bot method and saved targets
working unchanged. The same shared controls serve `qwen serve` and
`WebShellWithProviders` when the host enables the relevant pages and supplies a
daemon workspace.

Deliver readable plain text and Markdown in a static card, with explicit local
limits, optional signing, bounded requests and sanitized failures. The public
delivery input remains a text string; there is no new message-format setting.

The scope excludes a test-send UI or API, inbound callbacks, interactive buttons
or card callbacks, CardKit sessions, streaming/card updates, attachments,
dynamic recipients, configurable mentions, user-ID discovery, automatic request
splitting, retries/outbox, new task lifecycle events, other platforms and Generic
Webhook. Current per-run and manual-trigger delivery semantics do not change.

## Channel and configuration contract

Export a separate `feishu-webhook` plugin from the existing Feishu package,
preserving its existing application-bot `plugin` export. Register it as a built-in
type using the existing registry. Do not add a new Channel package, SDK action,
delivery target kind, capability version or provider-specific task field.

The plugin declares `outboundOnly: true` and `defaultDeliveryTarget` with the
fixed logical destination `chat/default`. One named Channel owns one configured
endpoint. Tasks store the existing channel/type/ID tuple, never the endpoint or
its credentials. Updating the endpoint changes future sends through that named
Channel. The adapter accepts only its own `chat/default` group destination,
without a thread, and rejects arbitrary IDs, general execution targets and
inbound webhook task targets.

Configuration has a required secret `webhookUrl` and optional secret
`signingSecret`. Use the existing environment-reference, redaction and
preserve/replace/clear mechanisms, including optional signing-secret environment
resolution. Management validation may preserve an environment reference;
runtime connection validates the resolved value. Clearing a required URL must
not save an invalid configuration. Secret values and endpoint tokens must not
appear in public catalog metadata, task records, normal readback or diagnostics.

The endpoint policy accepts HTTPS on `open.feishu.cn` with the path
`/open-apis/bot/v2/hook/<nonempty token>`. Reject other hosts or paths, query
parameters, fragments, user information and custom ports. This is an intentional
endpoint allowlist, not support for Lark domains, arbitrary proxies encoded into
the URL or generic HTTP targets. The local validator accepts a single nonempty URL-unreserved token segment
(letters, digits, `-`, `.`, `_`, `~`), excluding encoded separators. This is a
local constraint, not a claim about the platform's complete token grammar.
Redirects are rejected. Workspace proxy configuration remains the supported
transport override.

Existing catalog projection, management storage, daemon delivery, worker IPC,
authorization and SDK wire types already support this contract. Reuse them
without production changes unless implementation reveals a concrete gap.

## Static Markdown card

Send one JSON request with `msg_type: "interactive"` and a `card` object using
`schema: "2.0"`. Its body contains only Markdown elements:

```json
{
  "msg_type": "interactive",
  "card": {
    "schema": "2.0",
    "body": {
      "elements": [{ "tag": "markdown", "content": "Task result" }]
    }
  }
}
```

The official custom-bot guide includes this card schema and states that custom
bot cards do not support postback interaction. The protocol name `interactive`
does not introduce interactive controls or callbacks in this feature.

Do not add a header/title, preview summary, streaming state, collapse controls
or stop button. A summary would duplicate task text in the bounded request, and
the application-bot builder's other defaults are unnecessary here. Build a small
static envelope rather than changing that builder's output.

Reuse the pure `splitByTables` logic through a small export, preserving the
application-bot card structure and transport. Its fence recognition needs a
small correction: only line-start backtick or tilde fences change code-block
state, and closing fences must match the opener. This prevents table-like
content inside a tilde fence from being separated into broken card elements. This puts table
segments and surrounding text in separate Markdown elements within the same
card. It does not split delivery into multiple requests. The official schema 2.0
Markdown documentation allows at most four tables in one Markdown element and
describes automatic pagination after five data rows; keeping one table per
element fits that documented boundary. Preserve code-fenced table-like text and
verify mixed prose/table/code cases. Do not use application-bot `splitChunks` or
its character limit for webhook delivery.

Plain text, headings, lists, links, fenced code, tables, Chinese and emoji remain
valid input. Preserve their content without silent truncation or a general
Markdown conversion layer. Document Feishu's supported subset and rendering
limitations; do not promise full GitHub-flavored Markdown or identical rendering
across clients.

### Literal mention markup

Task output must not request mentions intentionally. Before building Markdown
elements, neutralize complete opening and closing `at` tags, case-insensitively,
by replacing their literal delimiters with `&#60;` and `&#62;`. Preserve the tag's
remaining text and unrelated Markdown. For example:

```text
<at id=all></at>
→ &#60;at id=all&#62;&#60;/at&#62;
```

Apply this policy consistently to task text, including code examples and tags
inside other supported markup. Do not decode existing entities before escaping
or introduce ID lookup. Cover individual mentions, `ids` lists, quoted
attributes, case/whitespace variations, closing tags, nested font markup and
already escaped text in tests.

The current official Markdown documentation recommends numeric HTML entities
for literal `<` and `>`. It does not specify every parsing pass, malformed tag
interpretation or repeated entity-decoding behavior. Unit tests can prove our
transformation, not every client's notification behavior. Live acceptance must
check displayed content and absence of mention notifications; unresolved parser
variants remain an evidence boundary, not a claim of a complete HTML sanitizer.
Code examples may display entity text depending on the client's code renderer;
exact rendering of such examples is part of live verification.

## Signing and request size

When `signingSecret` is present, generate a fresh seconds timestamp for each
send. Form the UTF-8 HMAC-SHA256 key as `timestamp + "\n" + signingSecret`, sign
an empty byte message, and Base64-encode the digest. Add `timestamp` and `sign`
to the outer JSON object. Do not reuse DingTalk's millisecond/query-signing
algorithm or cache a signed request.

The following expected values were computed independently with Python
`hmac`/`hashlib`/`base64` and should be fixed test vectors:

| Timestamp    | Secret        | Expected `sign`                                |
| ------------ | ------------- | ---------------------------------------------- |
| `1599360473` | `test-secret` | `wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=` |
| `1700000000` | `飞书-secret` | `lUmB8m+S7VOLIZHF9rQzsIijqKEqJb5ra9uO6rvwCfE=` |

After mention handling, card construction and optional signing, serialize the
final request once. Measure that same string with `Buffer.byteLength(body,
"utf8")`, then pass it to fetch. Use **20,000 bytes as a conservative local
request budget**. Accept a request at that local boundary and reject a larger
one before any network request with an explicit sanitized size error. The bound
includes JSON syntax/escaping, all Markdown elements and signing fields.

The endpoint-specific guide states a 20 KB whole-request limit without defining
20,000 versus 20,480 bytes. A general message FAQ contains different guidance.
The local 20,000-byte choice is conservative; it is not a verified exact platform
maximum and does not resolve that documentation discrepancy. Keep the existing
shared delivery bound as an earlier guard. Do not silently truncate, fall back to
another payload, split messages or retry after a local or remote rejection.

## Transport, failures and lifecycle

Follow the reviewed DingTalk adapter's request lifecycle directly. Use the
resolved workspace proxy with request-scoped Undici fetch/dispatcher when
needed, honoring existing `NO_PROXY` bypass behavior. Do not mutate a global
dispatcher. Declare any required Undici dependency directly in the Feishu
package. This second adapter does not justify a broad shared HTTP framework;
extract a helper only if the concrete reuse is small and preserves behavior.

Each delivery attempt performs at most one request, with a **15-second timeout**
and a **16,384-byte response-body limit**. Bound reading before parsing JSON,
cancel/release the reader when necessary, and clean up timeout and dispatcher
resources on success, failure or cancellation. Do not follow redirects or echo
response bodies in errors.

Only a successful HTTP response with a parsed object containing numeric
`code === 0` succeeds. Do not accept a string `"0"`, missing code or legacy
`StatusCode` / `StatusMessage` fields as success. Failures remain observable
through existing delivery results with bounded, sanitized reasons:

| Failure                                                   | Classification policy                                      |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| HTTP 408, 425, 429 or 5xx                                 | Transient                                                  |
| Other non-success HTTP response                           | Permanent                                                  |
| Feishu numeric business code `11232`                      | Transient; documented custom-bot rate limit                |
| Other nonzero business code                               | Permanent unless endpoint-specific evidence says otherwise |
| Malformed/missing business response or oversized response | Failure; do not infer success                              |

Transient classification does not add a retry. In particular, keyword, IP and
signature/time-window rejections must fail without exposing the platform's raw
message, endpoint or supplied content. Transport failures and cancellation do
not establish whether the remote service accepted a request; retain that
uncertainty in sanitized diagnostics. Do not assume throttling always uses HTTP
429 or provides `Retry-After`.

`connect()` validates local resolved configuration and marks the adapter ready
to send. It opens no persistent connection, creates no agent session and sends
no authentication/test message. Connected means locally ready, not remotely
verified. The explicit start/stop controls follow the existing Channel lifecycle.

Track in-flight requests and a connection generation as the DingTalk adapter
does. `disconnect()` prevents further sends, cancels current requests and starts
a drain; shutdown waits for settlement and resource cleanup. Reconnect must not
race a prior drain or an interrupted start. Preserve existing behavior during
workspace reload and Channel deletion.

## Shared Web behavior

Add `feishu-webhook` to the supported platform types and Feishu platform mark.
Group application-bot and webhook descriptors under a single Feishu entry,
independent of descriptor order. The method picker chooses the underlying
plugin type. Replace its DingTalk-specific title/description with neutral
connection-method wording and translate new/changed strings in all supported
locales (currently `en`, `zh-CN` and `ru`), following existing fallback conventions.

Map the webhook URL and signing-secret fields to translated labels/descriptions.
Reuse the existing secret editor, save validation and lifecycle controls.
`outboundOnly` already hides receive policies, pairing and agent-session
settings; do not add a parallel Feishu-specific editor. Preserve the existing
application-bot form and behavior.

Scheduled Tasks obtains the configured group from `defaultDeliveryTarget`,
without contact discovery or manual ID entry. Reuse its create/edit/clear and
read/list round trips, unavailable saved-target handling and workspace ownership
checks. Do not silently rewrite a saved unsupported target to `chat/default`.
The generic configured-group label remains localized. Existing persistent/per-run
restrictions and manual user/chat destinations continue to apply.

## Affected components and PR sequence

| PR  | Component                                                                  | Intended change                                                 |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `packages/channels/feishu/src/FeishuWebhookChannel.ts`                     | New outbound adapter, protocol, size and lifecycle handling     |
| 1   | `packages/channels/feishu/src/webhook-plugin.ts`, `src/index.ts`           | Plugin metadata, secret fields, factory and exports             |
| 1   | `packages/channels/feishu/src/markdown.ts` or a small pure helper          | Reuse table segmentation and correct fence recognition          |
| 1   | `packages/channels/feishu/package.json`, lockfile                          | Direct transport dependency if required                         |
| 1   | `packages/cli/src/commands/channel/channel-registry.ts`                    | Register the built-in plugin                                    |
| 1   | Collocated Feishu tests, registry tests and CLI delivery fixture           | Protocol, lifecycle, proxy, registration and delivery coverage  |
| 1   | User/design documentation and E2E plan                                     | Configuration, limitations and verification evidence            |
| 2   | `packages/web-shell/client/components/channels/channel-platform.ts`        | Recognize the webhook type and Feishu branding                  |
| 2   | `ChannelsManagerPage.tsx`, `ChannelEditorDialog.tsx` in the same directory | Platform grouping, method choice and translated field mapping   |
| 2   | `packages/web-shell/client/i18n.tsx`                                       | Neutral method copy and all supported locale entries            |
| 2   | Channel/editor/task tests and Web E2E flows                                | Configuration, secret editing, readiness and configured targets |

The backend PR remains usable through configuration and existing delivery APIs
before the Web PR merges. No source changes are expected in ChannelBase, daemon
routes, task persistence or SDK contracts. If implementation uncovers a required
contract change, revisit this design rather than broadening the PR silently.

## Validation and acceptance

Use focused tests with independent expected payloads and the fixed signing
vectors above. Cover endpoint validation and environment references; exact target
ownership; plain text and Markdown elements; mixed tables/code/prose; mention
transformation; Chinese/emoji and JSON escaping; signed/unsigned final byte
counts; and the 20,000/20,001-byte local boundary. Assert oversized requests
perform no HTTP send and every other attempt performs at most one.

Exercise HTTP and business errors separately, including keyword, IP, signature,
rate-limit, malformed/legacy/string-code responses and response-size overflow.
Verify error sanitization, timeout, concurrent stop/reconnect, drain completion,
workspace proxy/`NO_PROXY` routing, dispatcher cleanup and absence of global
dispatcher changes. Add a local delivery fixture through the existing daemon or
worker path without model calls or application credentials.

For Web, test both descriptor orders, application/webhook method selection,
translated secret fields and preserve/replace/clear behavior, omitted inbound
settings, start/stop/readiness, configured-target selection with no contacts,
saved unavailable/manual targets and task round trips. Cover shared Web behavior
in a browser, including narrow layout and workspace scoping. Existing application
bot and manual-target tests must remain passing.

Run relevant package tests, type checks, lint/format checks and builds. Record the
baseline, detailed E2E steps, simulated transport and results in
`.qwen/e2e-tests/feishu-webhook-delivery.md`. A local HTTPS/proxy fixture proves
our request and lifecycle handling;
it does not prove Feishu accepts credentials, renders cards or suppresses
notifications.

Record a separate live custom-bot smoke test when credentials are available:
signed and unsigned delivery as applicable, headings/lists/links, code, tables
with surrounding prose, Chinese/emoji, and literal mention variants including
already escaped text. Verify both rendering and absence of mention notifications.
Until then, mark this check **pending**. Pending live access does not prevent
local implementation/review, but must not be reported as live acceptance.

## Risks, open questions and follow-ups

- The exact remote byte cutoff and the discrepancy with the general FAQ remain
  unverified. The explicit conservative local budget is the initial policy.
- Official entity escaping supports the chosen mention transformation, but
  malformed/encoded variants and actual client parsing require live evidence.
  Do not expand supported mention behavior based only on fixture success.
- The table helper is a small existing formatter, not a complete Markdown
  parser. Test its fence/table boundaries and keep the application-bot card
  structure and transport unchanged; deeper Markdown parsing is a separate change if needed.
- Current sources establish `11232` as rate limiting. Do not copy speculative
  transient-code lists from unrelated Feishu APIs or third-party SDKs.
- Lark domains, other providers, Generic Webhook, richer cards and retry policies
  remain separate proposals. This feature introduces no speculative extension
  contract for them.

## References

- [Issue #16997](https://github.com/QwenLM/qwen-code/issues/16997)
- [Existing outbound webhook Channel design](2026-11-10-outbound-webhook-channels.md)
- [Feishu custom-bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- [Schema 2.0 Markdown component](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text?lang=zh-CN)
- [Feishu message FAQ](https://open.feishu.cn/document/server-docs/im-v1/faq?lang=zh-CN)
- [Uptime Kuma Feishu notification adapter](https://github.com/louislam/uptime-kuma/blob/c64c6d950db9149b3f0d98daf76ab591bdaabe7c/server/notification-providers/feishu.js)
- [Apprise Feishu adapter](https://github.com/caronc/apprise/blob/dcbd38584f8a9855f2343d369fd1f664ab06b3a7/apprise/plugins/feishu.py)

The open-source adapters are implementation cross-checks, not protocol authority
or new dependencies. Official endpoint documentation and the repository's
existing Channel contracts determine this design.
