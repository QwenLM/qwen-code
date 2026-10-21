# QwenCloud Source Attribution Header

[English](qwencloud-source-attribution.md) | [简体中文](qwencloud-source-attribution.zh-CN.md)

## Status

Implemented. Verified against the live 千问AI平台 Token Plan endpoint.

## Problem

千问AI平台 (China site) and QwenCloud (international site) attribute model usage to the calling Agent through the `X-DashScope-Source-Config` request header. The platform's integration guide asks every Agent to send it on each model request, with a single-line JSON value:

```json
{
  "channel": "qwencloud-inner-agents",
  "source": "model",
  "tags": { "t1": "qoder", "t2": "payg" }
}
```

Qwen Code sends no such header, so its traffic on these platforms is not attributed to it.

## Header value

| Field     | Value                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------ |
| `channel` | `qianwenai-inner-agents` for the China site, `qwencloud-inner-agents` for the international site |
| `source`  | `model`                                                                                          |
| `tags.t1` | `qwen-code`, stable across versions                                                              |
| `tags.t2` | `payg` on pay-as-you-go endpoints; omitted on Token Plan endpoints                               |

The site is derived from the request's host. Qwen Code is an Alibaba-owned Agent, hence `inner-agents`.

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

- **Exact host match.** The URL is parsed and the hostname compared exactly, so lookalike hosts (`maas.qwencloudapi.com.evil.example`) and path-embedded hosts do not match. Case and port are ignored.
- **No `t2` on Token Plan.** Token Plan keys share the `sk-sp-` prefix across the Personal and Team editions, so the client cannot tell them apart. The guide states the platform can resolve the plan from the API key; omitting the field avoids misreporting.
- **First-party value wins.** A `customHeaders` entry with the same name, in any casing, is removed, so the attribution can neither be overridden nor sent twice.
- **No setting.** The value is fully derived; there is nothing to configure.
- **One leaf module.** `packages/core/src/core/dashscope-source-config.ts` has no imports, so the provider, the Responses wire and WebSearch can all use it without an import cycle.

## Out of scope

- **Batch.** Batch jobs run asynchronously on the platform; whether a header on the submission request is attributed to the resulting model calls is unconfirmed.
- **Omni media tools.** They are experimental, off by default, and target Bailian unless the user repoints them.
- **Voice transcription and Qwen Live.** Their endpoint checks do not accept QwenCloud hosts.
- **Anthropic protocol.** No QwenCloud preset uses it; a hand-configured Anthropic entry pointing at these hosts is not attributed.
- **Proxies.** A request routed through a proxy host (for example `DASHSCOPE_PROXY_BASE_URL`) is not attributed, because the platform host is not visible to the client.

Any of these can call `withDashScopeSourceConfig` once they reach QwenCloud.

## Risks

- A gateway that rejects unknown headers would fail. The scope is limited to the platform's own hosts, and the live endpoint accepts the header.
- The value contains no user, session or request data.

## Validation

- Unit tests cover the host matrix (both sites, both plans, case and port, lookalike and path-embedded hosts, Bailian hosts) and the precedence over a conflicting `customHeaders` entry.
- Each of the three paths has a test asserting the header on a QwenCloud endpoint; disabling the injection fails all three.
- A live request to `token-plan.maas.qianwenaiapi.com` returned HTTP 200 both with and without the header.
- A real CLI run observed at the HTTP client sent exactly one header to the Token Plan host and none to a Bailian workspace host in the same session.

## Open questions

- Whether `qwen-code` must be registered in the platform's channel list before it is counted.
- Whether Batch submission headers propagate to the batch's model calls.
