# QwenCloud Source Attribution Header

[English](qwencloud-source-attribution.md) | [简体中文](qwencloud-source-attribution.zh-CN.md)

## Status

Implemented. The original header was verified against the live 千问AI平台 Token Plan endpoint. The CLI/Desktop identity refinement is covered by local regression tests.

## Problem

千问AI平台 (China site) and QwenCloud (international site) attribute model usage to the calling Agent through the `X-DashScope-Source-Config` request header. The platform's integration guide asks every Agent to send it on each model request, with a single-line JSON value:

```json
{
  "channel": "qwencloud-inner-agents",
  "source": "model",
  "tags": { "t1": "qoder", "t2": "payg" }
}
```

The original implementation attributed all Qwen Code traffic as `qwen-code`. CLI and Desktop traffic must now be distinguished by the runtime entry that owns the request.

## Header value

| Field     | Value                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------ |
| `channel` | `qianwenai-inner-agents` for the China site, `qwencloud-inner-agents` for the international site |
| `source`  | `model`                                                                                          |
| `tags.t1` | `qwen-code-desktop` for the Desktop runtime; `qwen-code-cli` otherwise                           |
| `tags.t2` | `payg` on pay-as-you-go endpoints; omitted on Token Plan endpoints                               |

The site is derived from the request's host. The approved requirement selects `inner-agents` for both sites, preserving the existing channels. Platform confirmation of Qwen Code's classification remains an open question; this refinement does not change those channel values.

## Scope

The header is sent only when the request's host is exactly one of:

| Host                               | `channel`                | `t2`    |
| ---------------------------------- | ------------------------ | ------- |
| `maas.qianwenaiapi.com`            | `qianwenai-inner-agents` | `payg`  |
| `token-plan.maas.qianwenaiapi.com` | `qianwenai-inner-agents` | omitted |
| `maas.qwencloudapi.com`            | `qwencloud-inner-agents` | `payg`  |
| `token-plan.maas.qwencloudapi.com` | `qwencloud-inner-agents` | omitted |

All other endpoints, including the Bailian (`dashscope.aliyuncs.com`, `*.maas.aliyuncs.com`, Coding Plan) and Qwen OAuth endpoints, are unchanged. The decision depends only on the host; the API key is not inspected.

Three request paths can reach these hosts in a default setup, and all three send the header:

1. Chat Completions, through the DashScope provider's headers. This covers the main session, subagents, the fast model, compaction and the vision bridge.
2. The Responses API wire.
3. The WebSearch side request, which the QwenCloud presets enable.

## Design decisions

- **Exact host match.** The URL is parsed and the hostname compared exactly, so lookalike hosts (`maas.qwencloudapi.com.evil.example`) and path-embedded hosts do not match. Case and port are ignored. This is deliberately narrower than the two endpoint gates that consume the same list: `isDashScopeProvider` and the WebSearch endpoint check suffix-match `QWENCLOUD_MAAS_HOSTS`, so a MaaS subdomain that is not in the table above is served as DashScope and passes the search gate, but is not attributed. Admission only has to pick the right API dialect; attribution writes a `channel`/`t2` pair onto the platform's dashboard, so it stays on the four hosts listed above.
- **No `t2` on Token Plan (accepted temporary behavior).** Token Plan keys share the `sk-sp-` prefix across the Personal and Team editions, so the client cannot tell them apart. The guide states the platform can resolve the plan from the API key; omitting the field avoids misreporting.
- **First-party value wins.** A `customHeaders` entry with the same name, in any casing, is removed, so the attribution can neither be overridden nor sent twice. There is deliberately no diagnostic for the removal: it is a documented policy with no switch, and the request still succeeds.
- **Runtime identity.** All three callers pass the existing `Config.getChannel()` value. Only `desktop` maps to `qwen-code-desktop`; CLI, daemon, ACP, other integrations and an unset channel map to `qwen-code-cli`. Desktop launchers already establish the channel, including the Tauri marker resolved by the ACP channel fallback. Derived agent Configs inherit it, including nested agents and model overrides. No new environment detection or identity state is needed.
- **No setting.** The value is derived from the endpoint and runtime channel; there is nothing to configure. Existing telemetry and privacy switches are unchanged.
- **One leaf module.** `packages/core/src/core/dashscope-source-config.ts` has no imports and owns `QWENCLOUD_MAAS_HOSTS` (re-exported by the DashScope provider), so the provider, the Responses wire and WebSearch can all use it without an import cycle. The leaf is the only copy of the two host strings: `telemetry/gen-ai-provider.ts` and `core/reasoning-overrides.ts` import `QWENCLOUD_MAAS_HOSTS` instead of repeating the literals (#15107). That import is safe precisely because the leaf has no imports of its own, so it cannot close a cycle back through the provider layer. Both consumers keep their own host-or-subdomain admission test and must not route through `buildDashScopeSourceConfig`, whose exact match deliberately covers only the bare and `token-plan.` forms. The four preset base URLs under `providers/presets/` embed the same hosts, and a test pins them to `SITE_CHANNELS`.
- **Configured host, not runtime host.** The decision reads the configured `baseUrl`. Qwen OAuth swaps the client's endpoint at runtime, but its configured `baseUrl` is the unparseable placeholder `DYNAMIC_QWEN_OAUTH_BASE_URL`, so it is never attributed; a test pins this.

## Out of scope

- **Model discovery.** `GET {baseUrl}/models` reaches these hosts when the QwenCloud presets list models, but it is not a model invocation, which is what the guide asks to attribute.
- **Batch.** Batch jobs run asynchronously on the platform; whether a header on the submission request is attributed to the resulting model calls is unconfirmed.
- **Omni media tools.** They are experimental and off by default. The caption, OCR and transcription tools default to Bailian. When omni is enabled on a QwenCloud model, the legacy temporary-upload channel reuses that model's endpoint; it uploads media and is not attributed.
- **Responses embeddings.** The Responses generator's embedding client sends only `customHeaders`; nothing in the product calls it today.
- **Voice transcription and Qwen Live.** Their endpoint checks do not accept QwenCloud hosts.
- **Anthropic protocol.** No QwenCloud preset uses it; a hand-configured Anthropic entry pointing at these hosts is not attributed.
- **Proxies.** A request routed through a proxy host (for example `DASHSCOPE_PROXY_BASE_URL`) is not attributed, because the platform host is not visible to the client.

Any of these can call `withDashScopeSourceConfig` once they reach QwenCloud.

## Risks

- A gateway that rejects unknown headers would fail. The scope is limited to the platform's own hosts, and the live endpoint accepts the header.
- The value contains no user, session or request data.

## Validation

- Unit tests cover the host matrix (both sites, both plans, case and port, lookalike and path-embedded hosts, Bailian hosts) and the precedence over a conflicting `customHeaders` entry.
- Each of the three paths checks CLI, Desktop and unset runtime channels, alongside custom-header precedence. The leaf tests cover the runtime mapping for both plans; derived Config tests verify channel inheritance through nested agents. Dropping a caller's channel argument breaks its Desktop case.
- A live request to `token-plan.maas.qianwenaiapi.com` returned HTTP 200 both with and without the header.
- The retained CLI wire evidence shows exactly one attribution header on the Token Plan request. A separate Bailian control process sent no attribution header; these were not observations from the same session.

## Open questions

- Whether Qwen Code is classified as an Alibaba-affiliated internal Agent (`inner-agents`) or an external ecosystem Agent (`outer-agents`). The guide asks each Agent team to confirm ownership before integration and does not list Qwen Code; the upstream tracking plan it cites may define the rule but was not accessible.
- Whether `qwen-code-cli` and `qwen-code-desktop` must be registered in the platform's channel list before it is counted.
- Whether omitting `t2` on Token Plan endpoints is acceptable to the platform.
- Whether Batch submission headers propagate to the batch's model calls.
