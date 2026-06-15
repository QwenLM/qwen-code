---
description: "Qwen Code outbound telemetry propagation design. Control trace context and session correlation headers for LLM provider requests."
---

# Telemetry: Outbound Trace Context & Session ID Header Propagation

> 配套 issue: [#4384](https://github.com/QwenLM/qwen-code/issues/4384)
> 父 issue: [#3731](https://github.com/QwenLM/qwen-code/issues/3731) (P3 deeper observability)
> 前置 PR: #4367 (resource attributes — merged 2026-05-21, commit `64401e1`)
> 基于 2026-05-21 对 qwen-code main 分支 + 直接验证的 claude-code 源码

## 修订历史

| 修订 | 日期       | 触发                                          | 摘要                                                                                                                                                                                                                                                                              |
| ---- | ---------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | 2026-05-21 | 初稿                                          | 全广播：所有出站 LLM 请求都带 `X-Qwen-Code-Session-Id` + `traceparent`                                                                                                                                                                                                            |
| R2   | 2026-05-22 | wenshao R2/R3 review                          | 边界安全：URL normalize、port matching、quote 对齐、staticCorrelationHeaders try/catch、host:port fallback strip                                                                                                                                                                  |
| R3   | 2026-05-23 | LaZzyMan REQUEST_CHANGES                      | **重大语义改动**：`X-Qwen-Code-Session-Id` 默认作用域收窄到 first-party（Alibaba/DashScope）host 白名单。详见 §11                                                                                                                                                                 |
| R4   | 2026-05-25 | LaZzyMan round-8 follow-up (scope conflation) | **PR scope 大幅收窄**：本 PR 仅保留 client HTTP span + OTLP loop guard；`traceparent` 默认 off（NoopTextMapPropagator）；新增 `outboundCorrelation.*` 顶级 namespace 放安全相关 toggle；R3 落地的整套 `X-Qwen-Code-Session-Id` 机器**移除本 PR**，搬到独立 follow-up PR。详见 §12 |

**特别提示**：阅读 §3.1（目标）/ §3.2（非目标）/ §4.3（Part B 设计）/ §4.4（配置 schema 影响）/ §5（文件改动清单）/ §9（与 claude-code 对比）/ §10（未来工作）/ §11（R3 host-allowlist scoping）时，请同时参考 §12 —— **R4 修订让 R1-R3 关于"本 PR 同时落地 traceparent + session id header"的论断不再成立**：本 PR 现仅为 telemetry observability + 独立的 outbound trace-context toggle，所有 outbound correlation header 工作（包括 R3 的 host allowlist）整体搬到独立 follow-up PR。R3 工作代码本身没浪费，挪到 follow-up PR 即可复用。

## 1. 背景

#4367 解决了**emitted telemetry 上的 attribute 与 cardinality**（操作员能给 span/log/metric 打 `user.id`/`tenant.id` 这类标签）。但有一类东西它没碰：**outbound LLM 请求的 HTTP header**。今天 qwen-code 发往 DashScope / OpenAI / Gemini / Anthropic 的请求**完全不带任何 cross-process correlation header**——既没有 W3C `traceparent`，也没有 session id。

后果：

1. trace context 在 qwen-code 进程边界断开。若模型服务（如 ARMS Tracing 接入的 DashScope）本身有 OTel instrumentation，它产生的 span 与 qwen-code 的 trace 彼此独立，端到端 trace tree 不存在。
2. 没有 session id 在 wire 上。后端要把 qwen-code 的 metric/log 与服务端日志关联，需要离线匹配 trace id 或时间戳，远不如直接读 header 简单。
3. 本地 trace 缺一层 client-side HTTP span。今天只能看 `api.generateContent` 的总耗时，看不到网络 TTFB / 响应体大小 / 重试次数。

## 2. 现状

### 2.1 仅启用了 `HttpInstrumentation`

`packages/core/src/telemetry/sdk.ts:330`：

```ts
instrumentations: [new HttpInstrumentation()],
```

`HttpInstrumentation` 只 hook Node 内建的 `http`/`https` 模块，**不**覆盖 `globalThis.fetch` / undici 路径。

### 2.2 两套 LLM SDK 都走 fetch / undici

| SDK                                              | HTTP 实现                                                                                                                          | `HttpInstrumentation` 是否覆盖 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `openai@5.11.0`                                  | `globalThis.fetch`（Node 18+ 即 undici）。证据：`node_modules/openai/internal/shims.mjs` 报错 `'fetch' is not defined as a global` | ❌                             |
| `@google/genai@1.30.0`                           | `globalThis.fetch` + `new Headers()`。证据：`dist/node/index.mjs` 内的 `new Headers()` 调用                                        | ❌                             |
| `@anthropic-ai/sdk`（anthropicContentGenerator） | 同样基于 fetch                                                                                                                     | ❌                             |

### 2.3 代码库零 manual propagation

```
grep -rn "propagation\.\|setGlobalPropagator\|W3CTraceContext\|traceparent" packages/core/src --include="*.ts" | grep -v "\.test\."
```

→ 空。没有任何 `propagation.inject()` 调用，没有手动 traceparent 注入。

### 2.4 各 provider 的 `defaultHeaders` 现状

OpenAI 家族（用 `openai` SDK）：

所有 OpenAI 子 provider 都 `extends DefaultOpenAICompatibleProvider`。**buildHeaders override 行为分两类**（已 grep audit 验证）：

| Provider   | 文件                   | `buildHeaders()` 行为                                                                   | 影响                                           |
| ---------- | ---------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 基类       | `default.ts:63-74`     | 提供 `{ 'User-Agent' }` + customHeaders                                                 | 改这里                                         |
| DashScope  | `dashscope.ts:110-124` | **`override` 但不 call `super`**——返回 `User-Agent` + `X-DashScope-*` 全新对象          | **必须单独改这里**，否则 correlation header 丢 |
| OpenRouter | `openrouter.ts:20-30`  | `override` 但**先 `const baseHeaders = super.buildHeaders()`**                          | 改基类自动继承 ✅                              |
| DeepSeek   | `deepseek.ts`          | 不 override `buildHeaders`（只 override `buildRequest` / `getDefaultGenerationConfig`） | 改基类自动继承 ✅                              |
| Minimax    | `minimax.ts`           | 同 deepseek                                                                             | 自动继承 ✅                                    |
| Mistral    | `mistral.ts`           | 同 deepseek                                                                             | 自动继承 ✅                                    |
| ModelScope | `modelscope.ts`        | 同 deepseek                                                                             | 自动继承 ✅                                    |

→ **OpenAI 家族需要触动 2 个文件**：`default.ts` 和 `dashscope.ts`。其余 5 个自动继承。

Google Gemini：

| Provider | 文件                           | 头注入路径                                                     |
| -------- | ------------------------------ | -------------------------------------------------------------- |
| Gemini   | `geminiContentGenerator.ts:59` | `new GoogleGenAI({ httpOptions: { headers } })` — SDK 原生支持 |

Anthropic：

| Provider  | 文件                                                                                                   | 头注入路径       |
| --------- | ------------------------------------------------------------------------------------------------------ | ---------------- |
| Anthropic | `anthropicContentGenerator.ts:177` (`buildHeaders`) + `:212` (`defaultHeaders` arg to `new Anthropic`) | `defaultHeaders` |

**总计 4 个 SDK 构造点**需要注入 session id header。所有 SDK 都已支持 `defaultHeaders` / `httpOptions.headers`，无需 fetch wrapper。

### 2.5 已有的 proxy 与 fetch 配置

`provider/default.ts:87-89`：

```ts
const runtimeOptions = buildRuntimeFetchOptions(
  'openai',
  this.cliConfig.getProxy(),
);
```

`buildRuntimeFetchOptions` 在用户配 proxy 时返回 `{ fetch: customFetch }` 或类似，触发 `setGlobalDispatcher(new ProxyAgent(...))`（见 `config.ts:1126-1128`）。**undici 全局 dispatcher 模式与 `UndiciInstrumentation` 兼容**——它通过 monkey-patch `globalThis.fetch` 与 undici 的 channel diagnostics 协作，不依赖具体 dispatcher。

## 3. 目标 / 非目标

### 3.1 目标

- 所有 outbound LLM 请求自动带 W3C `traceparent` header（OTel SDK 默认的 `W3CTraceContextPropagator`）
- ~~所有~~ 出站 LLM 请求带 `X-Qwen-Code-Session-Id` header（claude-code 同款产品命名空间） — **R3 修订**：默认仅向 first-party (Alibaba/DashScope) host 注入，第三方 provider 默认不发；详见 §11
- 自动避免对 OTLP exporter endpoint 自身的 trace（feedback loop）
- 给 LLM 请求加一层精确的 client span（网络耗时 vs 模型耗时分离）
- 覆盖 4 个 provider 构造点：OpenAI 基类、DashScope override、Gemini、Anthropic
- streaming 请求 / proxy 模式 / 重试场景全部不退化
- 与 #4367 的设计哲学一致：通过 `defaultHeaders` 这种 SDK-native 选项 — **R1 修订**：因 staleness 问题转用 fetch wrapper；**R3 修订**：fetch wrapper 内再叠加 host gate

### 3.2 非目标

- **`baggage` header**：标准 SDK 已支持，但 qwen-code 没调 `propagation.setBaggage()`，默认不会发送。本设计不主动开启。
- **subprocess `TRACEPARENT` env var 继承**：claude-code 给 Bash/PowerShell 子进程注入 `TRACEPARENT`。qwen-code 的 `BashTool` 没做。是独立 follow-up sub-issue。
- **inbound `TRACEPARENT` / `TRACESTATE` 读取**：claude-code 的 `-p` 模式和 Agent SDK 从 env 读 traceparent 接续父进程 trace。qwen-code 没做。独立 follow-up。
- **`X-Qwen-Code-Request-Id`**：claude-code 有 `x-client-request-id`，对超时容错 correlation 有用。本期不做，可作为下一个 sub-issue。
- **自定义 propagator（B3 / Jaeger / X-Ray）**：默认 W3C 已覆盖 99% 场景。可作为 future config option。
- ~~**per-endpoint 选择性注入**：claude-code 对第三方 endpoint (Bedrock / Vertex) 不发 traceparent；qwen-code 没有第三方区分需要，统一发即可。~~ — **R3 修订**：此论断已被推翻。LaZzyMan review 指出 qwen-code 是开源 CLI 连接多个第三方 provider（OpenAI / Anthropic / OpenRouter / 等），claude-code 的 first-party→first-party 类比不适用；session id header 必须按 host 区分。详见 §11。`traceparent` 仍按 R1 设计全注入（OTel 标准 header，且 trace id 是 `sha256(sessionId)` 哈希值），可作为独立 follow-up 加 per-destination toggle（`telemetry.propagateTraceContext`）。

## 4. 设计

### 4.1 总体分层

```
┌─ qwen-code process ────────────────────────────────────────────┐
│                                                                │
│  ┌─ session-tracing.ts ─┐                                     │
│  │ active span ctx      │                                     │
│  └──────┬───────────────┘                                     │
│         │                                                      │
│         ▼                                                      │
│  ┌─ propagation.inject() (called by undici instrumentation) ─┐│
│  │ writes `traceparent: 00-<traceId>-<spanId>-01` to headers ││
│  └─────────────────────────────────────────────────────────────┘│
│         │                                                      │
│  ┌──────▼──────────────────────────────────────────────────┐  │
│  │   fetch() — undici, instrumented                        │  │
│  │   creates HTTP client span                              │  │
│  │   injects traceparent into request headers              │  │
│  │   (skipped via ignoreRequestHook if endpoint is OTLP)   │  │
│  └─────────────────────────────────────────────────────────┘  │
│         │                                                      │
│         │   ┌─ defaultHeaders (per SDK constructor) ───────┐  │
│         │   │ { 'X-Qwen-Code-Session-Id': sessionId, ... } │  │
│         └───┴────────────────────────────────────────────────┘ │
│             │                                                  │
└─────────────┼──────────────────────────────────────────────────┘
              │
              ▼ outbound HTTP
   POST /v1/chat/completions
   traceparent: 00-...
   X-Qwen-Code-Session-Id: ...
   ... (existing User-Agent, X-DashScope-*, etc.)
```

两条注入路径独立、互不依赖：

| Layer                    | 何时注入                              | 由谁注入                                                      |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------- |
| `traceparent`            | 每次 fetch 调用时                     | `UndiciInstrumentation` 自动（来自 OTel SDK 默认 propagator） |
| `X-Qwen-Code-Session-Id` | SDK 构造时一次性写入 `defaultHeaders` | 应用代码                                                      |

### 4.2 Part A — `traceparent` via undici instrumentation

**改动点**：`packages/core/src/telemetry/sdk.ts`

```ts
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

// ...
const otlpUrls = [
  config.getTelemetryOtlpEndpoint(),
  config.getTelemetryOtlpTracesEndpoint(),
  config.getTelemetryOtlpLogsEndpoint(),
  config.getTelemetryOtlpMetricsEndpoint(),
]
  .filter((u): u is string => !!u)
  .map((u) => u.replace(/\/$/, ''));

instrumentations: [
  new HttpInstrumentation(),
  new UndiciInstrumentation({
    ignoreRequestHook: (request) => {
      // request.origin = "https://collector:4318", request.path = "/v1/traces"
      const url = `${request.origin}${request.path}`;
      return otlpUrls.some((e) => url.startsWith(e));
    },
  }),
],
```

#### 为什么 `ignoreRequestHook` 必须

OTel SDK 自己用 fetch 把数据 POST 到 OTLP collector。如果不跳，UndiciInstrumentation 会给"上报数据"的请求也建一个 span → 这个新 span 会被再次上报 → 无限循环 / 巨量噪声。每个 OTel 项目都踩过这个坑，OTel 文档明确推荐这种 hook。

#### 默认 propagator

OTel SDK `NodeSDK` 不传 `textMapPropagator` 时默认是 `CompositePropagator([W3CTraceContextPropagator, W3CBaggagePropagator])`。无需显式设置。

#### `traceparent` 格式

```
traceparent: 00-<32hex traceId>-<16hex spanId>-<01 sampled | 00 not sampled>
              ─┬─                                          ─┬─
               version (固定 00)                            flags
```

固定 55 bytes，无 padding。

#### `tracestate` 与 `baggage`

- `tracestate`: 上游传过来才续传；自己 inject 不会主动加（OTel SDK 行为）。
- `baggage`: 仅当 `propagation.setBaggage(ctx, ...)` 被调用过才有。qwen-code 不调，所以不会发送。

### 4.3 Part B — `X-Qwen-Code-Session-Id` via fetch wrapper（OpenAI / Anthropic）+ static headers（Gemini）

> **R3 修订**：以下设计描述的是 fetch wrapper 的 staleness 解决和 4 个 provider 集成点 — 这些都保留。但 wrapper 内部增加了一道 host allowlist gate，`staticCorrelationHeaders` 也加了 `destinationUrl` 参数。带 host gate 的最新实现代码与 default allowlist 见 §11。

#### Critical：staleness 问题与方案选择

天真做法（`defaultHeaders` 直接 bake-in `getSessionId()`）有**真 bug**：

1. `pipeline.ts:60` 在 contentGenerator 构造时一次性 `this.client = this.config.provider.buildClient()`，SDK client 的 `defaultHeaders` 在那一刻 capture 当时的 session id
2. `config.ts:1850` 的 session reset（用户 `/clear` 时触发）更新 `this.sessionId` 并 `refreshSessionContext()`，但**不重建 contentGenerator**
3. 后续 LLM 调用仍走旧 client → wire header 仍是旧 session id → 后端 correlation 错位

→ 必须读取 session id **per-request**，不能 bake at构造时。

#### 方案

```
                   ┌─ fetch 支持 ─┐  方案
OpenAI SDK          │     ✅       │  fetch wrapper (per-request 读 sessionId) ✅
Anthropic SDK       │     ✅       │  fetch wrapper ✅
@google/genai SDK   │     ❌       │  static httpOptions.headers + 接受 staleness
                   └──────────────┘
```

`@google/genai`'s `HttpOptions` interface 不支持 `fetch`（已 grep `node_modules/@google/genai/dist/genai.d.ts` 验证：只有 `baseUrl`/`apiVersion`/`headers`/`timeout`/`extraParams`）。所以 Gemini 走 static headers，与 OpenAI/Anthropic 不一致——这是 **known limitation**，见 §8.6。

#### 集中辅助函数（per-request fetch wrapper）

新文件 `packages/core/src/telemetry/llm-correlation-fetch.ts`：

```ts
import type { Config } from '../config/config.js';

/**
 * Wrap a fetch implementation so every outbound request gets correlation
 * headers (`X-Qwen-Code-Session-Id`) populated from the **current** session
 * id, not the value captured when the SDK client was constructed.
 *
 * Matches claude-code's pattern (src/services/api/client.ts:370-390 —
 * `buildFetch()`). Per-request injection is necessary because `/clear`
 * resets the session id mid-process; SDK clients (and their static
 * `defaultHeaders`) are NOT recreated on reset.
 *
 * Caller responsible for choosing the base fetch — usually
 * `runtimeOptions?.fetch ?? globalThis.fetch` so proxy-aware fetch is
 * preserved when ProxyAgent is in use.
 *
 * If telemetry is disabled, returns baseFetch unchanged (no correlation
 * header is added, matching the privacy stance of §3.1).
 */
export function wrapFetchWithCorrelation(
  baseFetch: typeof fetch,
  config: Config,
): typeof fetch {
  return async function correlationFetch(input, init) {
    if (!config.getTelemetryEnabled()) {
      return baseFetch(input, init);
    }
    const sid = config.getSessionId();
    if (!sid) {
      // Defensive: empty header value is rejected by some HTTP middleware.
      // Skip injection rather than send `X-Qwen-Code-Session-Id: `.
      return baseFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set('X-Qwen-Code-Session-Id', sid);
    return baseFetch(input, { ...init, headers });
  };
}
```

Companion helper for the SDKs that can only take static headers (Gemini):

```ts
/**
 * Static correlation headers. Captures the session id at call time —
 * **subject to staleness** if the host SDK keeps these headers in a
 * captured-at-construction slot (e.g. `@google/genai`'s `httpOptions.headers`).
 * Prefer `wrapFetchWithCorrelation` whenever the SDK exposes a `fetch` hook.
 */
export function staticCorrelationHeaders(
  config: Config,
): Record<string, string> {
  if (!config.getTelemetryEnabled()) return {};
  return { 'X-Qwen-Code-Session-Id': config.getSessionId() };
}
```

#### 集成点 1: `provider/default.ts` (OpenAI 基类)

`buildClient()` 改动——compose 现有 `runtimeOptions.fetch`（proxy）与我们的 wrapper：

```ts
buildClient(): OpenAI {
  // ... existing ...
  const runtimeOptions = buildRuntimeFetchOptions('openai', this.cliConfig.getProxy());
  const baseFetch =
    (runtimeOptions as { fetch?: typeof fetch } | undefined)?.fetch
    ?? globalThis.fetch;
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout,
    maxRetries,
    defaultHeaders,
    ...(runtimeOptions || {}),
    // After spread, override `fetch` so our correlation wrapper wraps the
    // proxy-aware fetch (or globalThis.fetch when no proxy).
    fetch: wrapFetchWithCorrelation(baseFetch, this.cliConfig),
  });
}
```

`buildHeaders()` itself unchanged.

#### 集成点 2: `provider/dashscope.ts` (override)

`buildClient()` 同样的 compose 模式（它本来就 override buildClient）。`buildHeaders()` 不动。

#### 集成点 3: `geminiContentGenerator/index.ts` (factory, NOT 构造器)

**修正先前设计的过度声明**：`geminiContentGenerator.ts` 构造器**不需要**改签名。`index.ts:48` 的 factory 函数已经接收 `gcConfig: Config`（line 33 已经在用 `gcConfig?.getUsageStatisticsEnabled()`），只需要在 factory 里把 correlation 静态 headers merge 进 `httpOptions.headers`：

```ts
// geminiContentGenerator/index.ts
let headers: Record<string, string> = { ...baseHeaders };
if (gcConfig?.getUsageStatisticsEnabled()) {
  // ... existing x-gemini-api-privileged-user-id ...
}
headers = { ...headers, ...staticCorrelationHeaders(gcConfig) }; // ← 新增
const httpOptions = config.baseUrl
  ? { headers, baseUrl: config.baseUrl }
  : { headers };
// new GeminiContentGenerator(...) unchanged
```

零 signature 改动。

#### 集成点 4: `anthropicContentGenerator.ts`

Anthropic SDK 同样接受 custom `fetch`（已经在用 `buildRuntimeFetchOptions`）。把 `buildClient` 路径里那个 fetch wrap 一下，方式同 OpenAI default.ts。`buildHeaders` 不变。

#### 优先级链

不变：用户的 `customHeaders` 在 `defaultHeaders` merge 中仍然赢（见 §8.2 spoofing 讨论）。fetch wrapper 注入的 `X-Qwen-Code-Session-Id` 在 SDK 的 headers list 之**后**追加到最终 `Headers` 对象上——以 Node `Headers.set()` 的语义，等于覆盖任何之前同名的（包括 user 的 customHeaders 里写的同名 header）。

**对 OpenAI/Anthropic（fetch wrapper 路径）**：correlation > customHeaders > SDK defaults。
**对 Gemini（static headers 路径）**：customHeaders > correlation > SDK defaults（沿用既有 spread 顺序）。

差异是 fetch wrapper 路径下 spoofing 不再可能（fetch wrapper 在 SDK headers 之后跑）。这是 **bug 修复的副产品**，并非有意收紧——但更安全。要在 §8.2 明示。

### 4.4 配置 schema 影响

~~**几乎为零**。本设计不引入新 setting~~ — **R3 修订**：引入了一项新 setting `telemetry.sessionIdHeaderHosts: string[]`，用于覆盖默认的 first-party host 白名单。schema 项已加入 `packages/cli/src/config/settingsSchema.ts`，描述与 override 语法（`["*"]` 恢复广播 / `[]` 全关 / 自定义数组）见 §11。原文以下描述仅适用于 R3 之前：

- `traceparent` 注入由 telemetry enabled 触发（已有 toggle）
- `X-Qwen-Code-Session-Id` 注入也由 telemetry enabled 触发
- `ignoreRequestHook` 的 OTLP url 已经从现有 config 读

未来可以加的 setting（**out of scope**）：

- `telemetry.outboundCorrelationHeader`: 自定义 header name（默认 `X-Qwen-Code-Session-Id`）
- `telemetry.outboundPropagationDisabled`: 全局关闭（如果 LLM 服务对未知 header 严格）
- ~~per-destination header scope toggle~~ — **R3 已落地**，见 §11

## 5. 文件改动清单

| 文件                                                                            | 改动类型 | 说明                                                                                                                                                            |
| ------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/package.json`                                                    | 加依赖   | `@opentelemetry/instrumentation-undici`                                                                                                                         |
| `packages/core/src/telemetry/sdk.ts`                                            | 修改     | +`UndiciInstrumentation` + `ignoreRequestHook`                                                                                                                  |
| `packages/core/src/telemetry/llm-correlation-fetch.ts`                          | 新文件   | `wrapFetchWithCorrelation()` (OpenAI/Anthropic) + `staticCorrelationHeaders()` (Gemini fallback)                                                                |
| `packages/core/src/core/openaiContentGenerator/provider/default.ts`             | 修改     | `buildClient()` 在 `new OpenAI({...})` 里加 `fetch: wrapFetchWithCorrelation(baseFetch, cliConfig)`                                                             |
| `packages/core/src/core/openaiContentGenerator/provider/dashscope.ts`           | 修改     | 同上（override `buildClient`）                                                                                                                                  |
| `packages/core/src/core/geminiContentGenerator/index.ts`                        | 修改     | factory 函数里 merge `staticCorrelationHeaders(gcConfig)` 进 `httpOptions.headers`（**caller 已有 Config，零 signature 改动** — 修正之前的 over-specification） |
| `packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts` | 修改     | `buildClient` 路径下用 `wrapFetchWithCorrelation` 包 SDK 的 `fetch` option                                                                                      |

**显式 audited 但无需改动**（避免 reviewer 怀疑漏路径）：

- `packages/core/src/qwen/qwenContentGenerator.ts` — `extends OpenAIContentGenerator`，用 `DashScopeOpenAICompatibleProvider`，**自动继承 dashscope.ts 的 buildClient 改动**。所有 Qwen OAuth 流程同样受益。
- `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts` — wrapper 模式，不构造 SDK client（它包装其他 contentGenerator 做 telemetry logging），无需改动。
- `packages/core/src/core/contentGenerator.ts` — factory 入口，不持有 client。
  | `packages/core/src/telemetry/sdk.test.ts` | 修改 | 加 undici instrumentation 注册 + ignoreRequestHook 测试 |
  | `packages/core/src/telemetry/llm-correlation-fetch.test.ts` | 新文件 | telemetry-on/off 行为单测 + per-request 读 sessionId 验证（critical：session reset 后 wrapped fetch 读到新 id） |
  | 各 provider 的 `*.test.ts` | 修改 | 断言 SDK 构造时 `fetch` option 是 wrapped 版本（OpenAI/Anthropic）；断言 Gemini 构造时 `httpOptions.headers` 含 `X-Qwen-Code-Session-Id` |
  | `docs/developers/development/telemetry.md` | 修改 | 新增 "Trace context & session correlation propagation" 段 |
  | `docs/design/telemetry-outbound-propagation-design.md` | 本文件 | 设计文档 |

## 6. 分 PR 拆分

按 review 友好度分两个 PR（也可以合一，规模允许）：

### PR 1 — `traceparent` 自动注入（structural）

- 加 `@opentelemetry/instrumentation-undici` 依赖
- `sdk.ts` 加 `UndiciInstrumentation` + `ignoreRequestHook`
- 测试：SDK 注册、OTLP endpoint 不被 trace
- 文档片段

**风险**：低。Additive。已有 client span 是 net 增益，不会改变现有 span 结构。

### PR 2 — `X-Qwen-Code-Session-Id` header（结合 helper 函数）

- 新文件 `llm-correlation-headers.ts`
- 4 个 provider 集成
- 测试：每个 provider 断言 header 存在；telemetry-off 时不发
- 文档片段

**风险**：低-中。要小心 `geminiContentGenerator` 构造器签名扩展可能波及调用方。

### PR 3（可选） — Docs + E2E verify

- 完善 `telemetry.md` 段落
- 加 E2E verify script（复用 `/tmp/verify-telemetry-pr-4367.mjs` 模式）：实际跑 fetch + 抓 header

也可以合并到 PR 2 里。

### 顺序偏好

PR 1 和 PR 2 技术上**互相独立**——不共享代码。但**推荐 PR 1 先合**：

- `traceparent` 是 OTel **标准** header，任何 OTel-aware collector / 后端立刻识别 → 用户立即获益
- `X-Qwen-Code-Session-Id` 是**产品自定义** header，需要后端配置识别才有价值 → 价值滞后
- 万一 PR 2 review 周期长，PR 1 已经把 cross-process trace 跑通了
- PR 1 是 additive structural（低风险），适合先建立信心

## 7. 测试计划

### 7.1 `sdk.ts` 单测

- ✅ `UndiciInstrumentation` 在 `NodeSDK` 的 `instrumentations` 中存在
- ✅ `ignoreRequestHook` 对 `https://collector:4318/v1/traces` 返回 true
- ✅ `ignoreRequestHook` 对 `https://dashscope.aliyuncs.com/...` 返回 false
- ✅ trailing slash 与无 trailing slash 都正确匹配

### 7.2 `llm-correlation-fetch.ts` 单测

**`wrapFetchWithCorrelation`**：

| 场景                                                    | 期望                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `getTelemetryEnabled() === false`                       | wrapped fetch = baseFetch（不加任何 header）                           |
| `getTelemetryEnabled() === true`, sessionId = "abc-123" | wrapped fetch 发出的 init.headers 含 `X-Qwen-Code-Session-Id: abc-123` |
| `init.headers` 已有 `X-Qwen-Code-Session-Id: spoof`     | wrapper 后覆盖为真 sessionId（fetch wrapper 路径不允许 spoof，§8.1）   |
| **session reset 后 wrapped fetch 被再次调用**           | **读取新 sessionId**（regression guard for staleness fix）             |
| baseFetch reject                                        | wrapper 透传 reject 不吞                                               |

**`staticCorrelationHeaders`**（Gemini path）：

| 场景                                                    | 期望返回                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `getTelemetryEnabled() === false`                       | `{}`                                                             |
| `getTelemetryEnabled() === true`, sessionId = "abc-123" | `{ 'X-Qwen-Code-Session-Id': 'abc-123' }`                        |
| sessionId 中含 unicode（`會話-1`）                      | 原样返回——HTTP header value 由 SDK 负责编码                      |
| sessionId 为空字符串                                    | `{ 'X-Qwen-Code-Session-Id': '' }`——业务 invariant，不在此层校验 |

### 7.3 Per-provider 集成测试

每个 provider 的 `buildHeaders()` / 构造测试加：

```ts
it('includes X-Qwen-Code-Session-Id when telemetry enabled', () => {
  const config = makeFakeConfig({
    sessionId: 'sess-xyz',
    telemetry: { enabled: true },
  });
  const provider = new DefaultProvider(genConfig, config);
  expect(provider.buildHeaders()['X-Qwen-Code-Session-Id']).toBe('sess-xyz');
});

it('omits X-Qwen-Code-Session-Id when telemetry disabled', () => {
  const config = makeFakeConfig({ telemetry: { enabled: false } });
  const provider = new DefaultProvider(genConfig, config);
  expect(provider.buildHeaders()).not.toHaveProperty('X-Qwen-Code-Session-Id');
});
```

### 7.4 E2E verification（tmux + local HTTP server）

⚠️ **不要** mock `globalThis.fetch` 来抓 header：`UndiciInstrumentation` 通过 undici 的 diagnostics channel hook，monkey-patching globalThis.fetch 可能完全 bypass instrumentation（取决于 patch 顺序），让 `traceparent` 注入测不到。**正确做法是起 local HTTP server**，让 SDK 真发请求，server 端记录收到的 headers。

写一个仿 `/tmp/verify-telemetry-pr-4367.mjs` 的脚本：

1. `http.createServer((req, res) => { capturedHeaders.push(req.headers); res.end('{}') })` 起本地 server
2. 启 telemetry + outfile + 把 OpenAI SDK 的 `baseURL` 指向 `http://127.0.0.1:<port>`（或者用 mock provider 让 SDK 真发 fetch）
3. 触发一次 `client.chat.completions.create(...)`（要带最小可解析的 mock 响应，否则 SDK 解析报错——本地 server 返回合法但空的 OpenAI 响应即可）
4. 断言 `capturedHeaders[0]` 含 `traceparent: 00-...` 和 `X-Qwen-Code-Session-Id: <sessionId>`
5. 另起一个 OTLP collector mock 在 different port，验证给它发的 OTLP 上报**不**触发 `traceparent` 注入（验证 `ignoreRequestHook`）
6. **额外：staleness 验证** — emit request 1 → call `config.resetSession(...)` → emit request 2 → 断言 request 2 的 `X-Qwen-Code-Session-Id` 是新 session id（**这是 #1 fix 的关键回归测试**）

### 7.5 回归保护

- streaming chat completion 的 fetch（带 `stream: true`）仍正常关闭——`UndiciInstrumentation` 历史上对 streaming response 的 span lifecycle 有过 bug，**实施时需要实际跑一次 streaming completion 端到端验证 client span 正常 end + 无 leaked span + 流不被截断**；不假设具体版本号已修
- proxy mode (`ProxyAgent`) 与 instrumentation 同时启用——`ignoreRequestHook` 仍按 endpoint 字符串匹配，proxy 不影响
- 重试（`maxRetries`）下每次重试都得到独立 client span，但都共享同一个 `traceparent` parent（理想是 retry 作为同一个父 span 下多个 child span — 这部分由 SDK 行为决定，本设计不强制）

## 8. 边界 / 边角

### 8.1 customHeaders override 与 spoofing 的不一致行为

不同 provider 路径的 spoofing 表面**不同**（设计后果，非原意收紧）：

| Provider 路径                           | spoofing 可能? | 原因                                                                                                                |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| OpenAI / Anthropic (fetch wrapper 路径) | ❌ 不能 spoof  | fetch wrapper 在 SDK headers list 之后 `headers.set('X-Qwen-Code-Session-Id', ...)`，覆盖 user customHeaders 的同名 |
| Gemini (static headers 路径)            | ✅ 可 spoof    | merge 顺序 `{ ...baseHeaders, ...correlationHeaders, ...customHeaders }`——customHeaders 最后赢                      |

claude-code 同样使用 fetch wrapper 路径，行为与 OpenAI/Anthropic 一致（spoofing 不能）。这是修 staleness bug 的副产品，不是原本要做的事。

**不打算"对齐"两条路径**——Gemini 路径的行为是 SDK 限制（没有 `fetch` hook）导致的，反向把 OpenAI 也降级到 static 不合理。

Session id spoofing 不是真威胁（用户控制本地，可以直接改 source code）。文档里要明示这个差异，避免 reviewer 看到 fetch wrapper 路径无法 spoof 时质疑 customHeaders 优先级。

### 8.2 OTLP collector URL 匹配的两类 edge case

#### (a) Auth token in URL

如果用户 OTLP endpoint 形如 `https://collector/path?token=secret`，`ignoreRequestHook` 的 `url.startsWith(e)` 比对应包含 query string。但 undici 给的 `request.path` 只到 path（不含 query），所以比较时 `e` 也只用到 path 部分。为安全起见，剥掉 query：

```ts
const otlpUrls = [...]
  .map((u) => u.replace(/\?.*$/, '').replace(/\/$/, ''));
```

#### (b) startsWith 跨 hostname 边界的理论 false positive

若 `e = "http://collector"`（无 port），来路 url = `http://collector-fake/v1/traces` 会被 startsWith 错误匹配。

**实际触发概率极低**：

- OTLP endpoint 几乎总带 port（4317 gRPC / 4318 HTTP），`http://collector:4318` 形态后 `-fake` 这种延伸不可能（port 后跟的是 `/`）
- 用户配 endpoint 不带 port 是配置错误，本来 SDK 就要默认 fallback

**如果想 harden**：解析 URL origin + path 分别比较，不用裸 startsWith：

```ts
const parsed = otlpUrls.map((u) => new URL(u));
return parsed.some(
  (e) =>
    `${request.origin}` === e.origin && request.path.startsWith(e.pathname),
);
```

本期不做——开销没必要，false positive 实际触发不到。

### 8.3 Vertex AI 模式的 Gemini

`@google/genai` 支持 `vertexai: true` 模式（用 GCP 凭据走 Vertex 端点而非 generative ai endpoint）。两种模式都走 fetch，所以 instrumentation 都覆盖。`httpOptions.headers` 在两种模式下都有效。

### 8.4 Anthropic SDK 已有 `defaultHeaders` 逻辑

`anthropicContentGenerator.ts:177` 已经在调 `buildHeaders()` 然后传给 `new Anthropic({ defaultHeaders })`。但 staleness 同样适用——本设计改用 `fetch` wrapper 路径（与 OpenAI 一致）。

### 8.5 SDK 与 fetch 之间的 trailer header

`openai` SDK 在 streaming 时可能用 `Transfer-Encoding: chunked` 和 trailer headers。这些都不影响 request-time 的 `traceparent` / `X-Qwen-Code-Session-Id` 注入——它们都是请求头，发出时一次性写入。

### 8.6 ⚠️ Known limitation: Gemini 的 session id 在 `/clear` 后 stale

由于 `@google/genai` SDK 不支持 `fetch` hook（`HttpOptions` 接口只有 `baseUrl`/`apiVersion`/`headers`/`timeout`/`extraParams`），Gemini provider 走 static `httpOptions.headers` 路径——session id 在 SDK 构造时 capture，**`/clear` 触发 session reset 后不刷新**。

**实际影响范围**：

- 用户启动 qwen-code → `/clear` → 用 Gemini 模型 → wire 上的 `X-Qwen-Code-Session-Id` 是旧 session id
- 后端 correlation 错位（trace id 和 log 已正确切换到新 session，但 wire header 滞后）

**为什么不修**（本期）：

- OpenAI / Anthropic 路径**没有这个 bug**（fetch wrapper 路径 per-request 读 session id）
- Gemini fix path 有几个选项，全部超出本期 scope（见下）

**Future fix path 选项**（按推荐顺序）：

| 选项                                          | 描述                                                                                 | 代价                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **A. Lazy invalidate** ★ 推荐                 | session reset 时只 mark contentGenerator dirty，下次 LLM 调用时 lazy recreate        | 小：~10 行加在 `resetSession` + LLM 调用入口；同步 API，无侵入                            |
| B. Eager recreate                             | session reset 时立即 `await createContentGenerator(...)`，需 async 化 `resetSession` | 中：API 改动级联多处                                                                      |
| C. Proxy headers object                       | 给 `httpOptions.headers` 包 Proxy 拦截 getter                                        | 风险高：`@google/genai` 内部是否 per-request 重读 headers 不可知，行为可能 silently break |
| D. 推动 `@google/genai` 上游加 `fetch` option | 提 PR 给 google-deepmind/generative-ai-js                                            | 长期；不可控                                                                              |

**文档要在用户面前说明**：使用 Gemini provider 时如果 `/clear` 后立刻有 LLM 调用，wire 上的 session id 在那一刻是旧的。可以靠 trace correlation 间接修正（spans/logs 上 session.id 已经是新的）。

应单开 follow-up sub-issue 跟踪选项 A。

## 9. 与 claude-code 对比

| 维度                         | claude-code                                                                                                                                          | qwen-code 本设计                                                                                                                                                              | 决策依据                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Session id header 命名       | `X-Claude-Code-Session-Id`（产品前缀）                                                                                                               | `X-Qwen-Code-Session-Id`（产品前缀）                                                                                                                                          | ✅ 同样命名空间策略                                                                                                                |
| Session id 注入机制          | SDK `defaultHeaders`（`client.ts:108`）+ 自定义 `buildFetch()` wrapper（`client.ts:370-390`，per-request `randomUUID()` 注入 `x-client-request-id`） | OpenAI/Anthropic 走 fetch wrapper（per-request 读 session id，避免 `/clear` staleness）；Gemini 走 static `httpOptions.headers`（SDK 限制）                                   | 与 claude-code 的 fetch wrapper 模式对齐。claude-code 也用 fetch wrapper 才能 per-request 加 `x-client-request-id`                 |
| Session id 持久性            | claude-code 没有 `/clear`-式 session reset；session = process                                                                                        | 有 `/clear` reset → fetch wrapper 路径自动跟随；static headers 路径会 stale（§8.6）                                                                                           | qwen-code 独有的复杂度                                                                                                             |
| Session id 编码              | HTTP header（不是 baggage）                                                                                                                          | HTTP header                                                                                                                                                                   | ✅ 同——backend 友好                                                                                                                |
| `traceparent` 注入           | 闭源；公开 docs 描述存在；开源 repo 无 `propagation.inject` / `UndiciInstrumentation` 引用                                                           | `@opentelemetry/instrumentation-undici` 自动                                                                                                                                  | claude-code 怎么实现的不可见。我们选 OTel 官方推荐路径，更轻                                                                       |
| `traceparent` 发送范围       | 仅第一方 Anthropic API；不发 Bedrock/Vertex/Foundry                                                                                                  | 发给所有出站 fetch (W3C 标准；trace id 是 `sha256(sessionId)` 哈希)。**R3 修订**：session id header 仅向 first-party (Alibaba/DashScope) 白名单注入，第三方默认不发。详见 §11 | R3 后 qwen-code 的 session header 与 claude-code 同样的 first-party-only 语义；`traceparent` 仍待 per-destination toggle follow-up |
| `x-client-request-id` (随机) | 有，自动                                                                                                                                             | 暂不做（独立 follow-up sub-issue 价值更高）                                                                                                                                   | 范围控制                                                                                                                           |
| 子进程 `TRACEPARENT` env     | 文档承认存在（实现闭源）                                                                                                                             | 不做（独立 follow-up）                                                                                                                                                        | 范围控制                                                                                                                           |
| 入站 `TRACEPARENT` 读取      | 文档承认存在（`-p` / Agent SDK 模式）                                                                                                                | 不做（独立 follow-up）                                                                                                                                                        | 范围控制                                                                                                                           |

**verified vs documented 注解**：

| claim                                           | 验证状态                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Claude-Code-Session-Id` via `defaultHeaders` | ✅ Open source `src/services/api/client.ts:108` 已读                                                                                              |
| `x-client-request-id` via fetch wrapper         | ✅ Open source `src/services/api/client.ts:370-390` 已读                                                                                          |
| `traceparent` 注入                              | ⚠️ 仅 docs.claude.com/docs/en/monitoring-usage.md 提到；开源 repo `grep -rn "propagation\.inject\|UndiciInstrumentation\|traceparent" src` 返回空 |

## 10. 未来工作

挂在 #3731 P3 下，本设计**不**包含但与之相关：

- **`X-Qwen-Code-Request-Id`** 随机 UUID per request（claude-code 等价：`x-client-request-id`）。对超时/timeout error correlation 有用——超时时服务端可能还没 assign request id，客户端先发的 id 是唯一关联手段。R3 修订后这个建议变得更有意义：per-request UUID 没有"跨请求行为画像"风险，可以作为"对所有 LLM provider 发送的支持/调试 header"。
- **`traceparent` 的 per-destination scope toggle** — R3 修订仅处理了 session id header 的作用域；`traceparent` 仍向所有出站 fetch 注入。可以加 `telemetry.propagateTraceContext: 'trusted-hosts' | 'all' | 'none'`，使用与 §11 同一份 allowlist 决定行为。
- **Gemini 的 session id staleness lazy-invalidate fix**（§8.6 选项 A）：`/clear` 时 mark contentGenerator dirty，下次 LLM 调用 lazy recreate。让 Gemini 路径也享受 fetch wrapper 的实时性。
- **子进程 `TRACEPARENT` env**：给 `BashTool` 执行子进程时注入 env，让外部工具能续传 trace。需要单独看 tool execution lifecycle。
- **入站 `TRACEPARENT`**：`--prompt` 模式启动时读 env，让 CI / 外部 orchestrator 能把 qwen-code 接到更大的 trace。
- **可配置 `correlationHeader` name**：让企业 ops 自定义 header（默认 `X-Qwen-Code-Session-Id`）。
- **`baggage` propagation 策略**：是否主动 set baggage 让 `user.id` / `tenant.id` 等也走 baggage 传到下游。本期不做，等需求明确。

## 11. R3 修订 — Host-Allowlist Scoping for `X-Qwen-Code-Session-Id`

> 触发：[LaZzyMan 在 PR #4390 的 REQUEST_CHANGES review](https://github.com/QwenLM/qwen-code/pull/4390)
> 落地 commit：`1c8528a56` (核心实现) + `cb162e716` (Vertex baseUrl fail-closed + `["*"]` trim 容错)

### 11.1 触发与论证

R1 设计把 `X-Qwen-Code-Session-Id` 向**所有**出站 LLM 请求注入，仅由 `telemetry.enabled` 控制。LaZzyMan review 指出了三个递进的问题：

1. **标签错位**：`feat(telemetry):` + `telemetry/` 路径 + `getTelemetryEnabled()` gate 让用户合理理解为"自家可观测性数据流向自家 collector"。但 `X-Qwen-Code-Session-Id` 不会到达 OTLP 后端，它走在 LLM API 请求里发给 DashScope / OpenAI / Anthropic / Gemini / OpenRouter / MiniMax / ModelScope / Mistral。两种不同的数据出口决策绑在一个开关上。

2. **claude-code 类比不成立**：R1 在 §9 把命名空间策略和 fetch wrapper 模式都"对齐"了 claude-code。但 claude-code 是 Anthropic 一方 → Anthropic 一方（single vendor, single direction），qwen-code 是开源 CLI → 多个第三方 provider。"一个稳定 cross-request UUID 广播到所有第三方"是 R1 没正面回答的问题。

3. **traceparent 是同一指纹的另一通道**：trace id = `sha256(sessionId).slice(0, 32)`，对接收方来说仍是稳定 per-session 标识符（哈希后不可逆，但同一 session 仍稳定）。

LaZzyMan 标定 severity：session id `high` / traceparent `medium`。

### 11.2 解法概要

**收窄默认作用域到 first-party hosts**。新增一项 setting：

```jsonc
"telemetry": {
  "sessionIdHeaderHosts": ["*"]                          // 恢复 R1 广播行为
  "sessionIdHeaderHosts": []                              // 全关 header
  "sessionIdHeaderHosts": ["api.mycompany.com",
                           "*.gateway.mycompany.internal"]
}
```

默认值（来自 `packages/core/src/telemetry/trusted-llm-hosts.ts:DEFAULT_SESSION_ID_HEADER_HOSTS`）：

```
dashscope.aliyuncs.com
dashscope-intl.aliyuncs.com
*.dashscope.aliyuncs.com
*.dashscope-intl.aliyuncs.com
*.alibaba-inc.com
*.aliyun-inc.com
```

这个集合的语义是"LLM provider、ARMS Tracing 后端、qwen-code distribution 同一法律实体"——也就是 claude-code 那个 single-vendor / single-direction 关系在 qwen-code 的对应集合。第三方 provider（OpenAI / Anthropic / OpenRouter / 等）默认**不**接收 header。

### 11.3 Pattern 语法（intentionally tiny）

`matchesTrustedHost(hostname, patterns)` 只支持两种模式，与 `DashScopeOpenAICompatibleProvider.isDashScopeProvider` 对齐：

- bare hostname → 精确匹配（case-insensitive）
- `*.suffix` → 匹配 `suffix` 自身 **AND** 任何子域；dot-anchored 拒绝 `evil-alibaba-inc.com` / `alibaba-inc.com.attacker.tld` 等 typo-suffix 攻击向量

不引入 regex、不引入端口/scheme 感知 globbing —— 让 settings 里的字符串就是它字面看起来的语义。

### 11.4 实现差异 vs R1

#### `wrapFetchWithCorrelation` (OpenAI / Anthropic)

R1 的 wrapper 只有 telemetry-enabled + sessionId 两个 gate。R3 在两者之间插入第三个 gate：

```ts
const trustedHosts =
  config.getTelemetrySessionIdHeaderHosts?.() ??
  DEFAULT_SESSION_ID_HEADER_HOSTS;
const broadcastAll = trustedHosts.some((p) => p.trim() === '*');

return async function correlationFetch(input, init) {
  if (!config.getTelemetryEnabled()) return baseFetch(input, init);
  if (!broadcastAll) {
    const host = extractRequestHost(input);
    if (!host || !matchesTrustedHost(host, trustedHosts)) {
      return baseFetch(input, init); // host gate
    }
  }
  const sid = config.getSessionId();
  if (!sid) return baseFetch(input, init);
  // ... header injection
};
```

`trustedHosts` 在 wrap 时一次性 snapshot（与 session id 的"每请求实时读"不同）。中途修改 `telemetry.sessionIdHeaderHosts` 需要重建 contentGenerator 才生效。`[" * "]` 之类带空格的写法通过 `.trim()` 兜底成 broadcast，避免 settings.json 手敲笔误沉默退化。

#### `staticCorrelationHeaders` (Gemini)

签名加一个 `destinationUrl?: string` 参数：

```ts
export function staticCorrelationHeaders(
  config: Config,
  destinationUrl?: string,
): Record<string, string> {
  if (!config.getTelemetryEnabled()) return {};
  if (!destinationUrl) return {}; // fail-closed: 不知道目的地就不发
  if (!matchesTrustedHost(new URL(destinationUrl).hostname, trustedHosts)) {
    return {};
  }
  return { [SESSION_ID_HEADER]: config.getSessionId() };
}
```

#### Gemini factory 集成

Gemini SDK 有两个不可见 default endpoint（`generativelanguage.googleapis.com` 与 `{region}-aiplatform.googleapis.com`，由 `vertexai` 决定），factory 层无法准确还原其中之一。R3 选择"`config.baseUrl` 没设就传 `undefined`"，让 helper fail-closed → 不发 header。运营商想要相关性必须显式设 `baseUrl`（也是 SDK 自己用来解 destination 的同一输入）。这一改动避免了猜错 Vertex destination 后被允许列表错误命中。

### 11.5 新文件 / 新代码

| 文件                                                                 | 说明                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/core/src/telemetry/trusted-llm-hosts.ts` (NEW)             | `DEFAULT_SESSION_ID_HEADER_HOSTS` + `matchesTrustedHost` + `extractRequestHost`                   |
| `packages/core/src/telemetry/trusted-llm-hosts.test.ts` (NEW)        | 单测，含 TLD-suffix 攻击向量、IPv6 fail-closed、port/userinfo/query 提取                          |
| `packages/core/src/telemetry/llm-correlation-fetch.ts`               | 加 host gate；`staticCorrelationHeaders` 加 `destinationUrl` 参数                                 |
| `packages/core/src/telemetry/llm-correlation-fetch.test.ts`          | 加 host-gate 8 个 case；`mockConfig` 用 `'hosts' in opts` 区分 "default allowlist" vs "broadcast" |
| `packages/core/src/telemetry/config.ts` (`resolveTelemetrySettings`) | 透传 `sessionIdHeaderHosts`                                                                       |
| `packages/core/src/config/config.ts`                                 | `TelemetrySettings.sessionIdHeaderHosts` + `getTelemetrySessionIdHeaderHosts()` getter            |
| `packages/core/src/core/geminiContentGenerator/index.ts`             | 传 `config.baseUrl` 给 helper；fail-closed when undefined                                         |
| `packages/core/src/core/geminiContentGenerator/index.test.ts`        | 重写 telemetry-on Gemini 测试以匹配新 fail-closed 语义                                            |
| `packages/cli/src/config/settingsSchema.ts`                          | `sessionIdHeaderHosts` JSON schema 入口                                                           |
| `packages/vscode-ide-companion/schemas/settings.schema.json`         | 由 `npm run generate:settings-schema` 重新生成                                                    |
| `docs/developers/development/telemetry.md`                           | "Session correlation header" 段落改写 + 默认 scope + override 语法                                |

### 11.6 对各 LazzyMan 论点的回应

| LazzyMan 论点                         | R3 回应                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① telemetry 标签错位                  | **化解**：在 DashScope 用例下，session id header 字面就是发给 ARMS Tracing 后端（同一法律实体），`telemetry.enabled` 语义对齐                                                       |
| ② cross-vendor stable identifier 广播 | **化解**：默认 allowlist 只含阿里系 first-party host；广播退化为 opt-in (`["*"]`)                                                                                                   |
| ③ traceparent 是同一指纹的另一通道    | **暂保留**：traceparent 仍按 R1 全注入。理由：W3C 标准、trace id 是 sha256 哈希、in-vendor trace 续接是 W3C 的核心设计场景。per-destination traceparent toggle 列入 §10 future work |

### 11.7 已知遗留 + 跟进

- **traceparent scope** — 见上文第 ③ 点，列入 §10
- **Per-request random UUID** (`X-Qwen-Code-Request-Id`) — LazzyMan 提的替代方案，列入 §10
- **Gemini staleness lazy-invalidate** (§8.6 选项 A) — 与 R3 解耦，独立 sub-issue
- **`matchesTrustedHost` IPv6 支持** — 当前 IPv6 destination 永不在 allowlist 上（`URL.hostname` 返回 `[::1]` 带方括号，pattern 语法无对应形式）。当前满足"命名 first-party endpoint"用例。若将来有 raw IP allowlist 需求再扩展。

## 12. R4 修订 — Scope Conflation Split

> 触发：[LaZzyMan round-8 follow-up review on PR #4390](https://github.com/QwenLM/qwen-code/pull/4390)
> 落地：本 PR 收窄；R3 落地的 session-id 整套挪到独立 follow-up PR

### 12.1 触发与论证

R3 化解了 LaZzyMan 第一轮 review 的「广播稳定指纹给第三方 provider」担忧（severity: high）。但在 round-8 follow-up 中他升级到更深的架构原则反对：

> "Telemetry is not a container for adjacent features. The `traceparent` cross-process propagation and the `X-Qwen-Code-Session-Id` header injection are **not telemetry**. They are outbound-identity / outbound-correlation work that uses some OTel APIs internally as an implementation detail."

他的核心元论点：

- **"telemetry" namespace 暗示 recipient = 用户自己的 OTLP collector**
- 但 `traceparent` 和 `X-Qwen-Code-Session-Id` 的 recipient = **第三方 LLM provider**
- 两类不同 recipient 应该有两类不同的同意决策树
- 即使默认行为安全（R3 已实现），把 wire-level 行为放在 `telemetry.*` 下**设了坏先例**：未来 telemetry PR 可以继续偷渡 wire 行为给第三方
- "If we accept that principle, the split is mechanical. If we don't, this PR is the wrong place to debate it because the technical fixes are already in."

### 12.2 解法概要（"方案 C" hybrid split）

经过几轮内部讨论（含 yiliang 提出的 customHeader 模板替代方案，最终判定 customHeader 不能携带 runtime-dynamic 值），决定走 **方案 C**：

**本 PR 留下**：

- `UndiciInstrumentation` 注册（产 client HTTP span → 用户自家 OTLP collector）
- OTLP feedback-loop guard（前者的必要副作用）
- **`NoopTextMapPropagator` 默认安装** → `propagation.inject()` 是 no-op → outbound `fetch` 上**不再有 `traceparent`**
- **新增 `outboundCorrelation.propagateTraceContext: bool` (默认 false)** 作为独立 namespace 顶级设置；设 true 时安装默认 W3C composite propagator
- 整套 `R3 session-id` 代码（`llm-correlation-fetch.ts` / `trusted-llm-hosts.ts` / `telemetry.sessionIdHeaderHosts` setting / 4 个 provider 集成点 / 所有相关测试）**全部移除**

**搬到 follow-up PR**：

- `X-Qwen-Code-Session-Id` header 整套机器（R3 实现复用）
- 进入新 `outboundCorrelation.*` namespace（具体 setting key TBD，但**不会**叫 `telemetry.*`）
- Follow-up PR 自带：threat model section、独立 review、security-relevant 标注的 docs
- `X-Qwen-Code-Request-Id` per-request UUID（LazzyMan 在 R3 round 提出的替代设计）也归入此 follow-up 的考虑范围

### 12.3 与 R3 R1 论点的映射

| R1/R3 论点                                          | R4 后状态                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| §3.1 "所有出站 LLM 请求带 traceparent"              | ❌ **R4 默认 off**；需 `outboundCorrelation.propagateTraceContext: true` 才开                                       |
| §3.1 "所有出站 LLM 请求带 `X-Qwen-Code-Session-Id`" | ❌ **R4 整套移出本 PR**，搬到 follow-up PR                                                                          |
| §4.3 fetch wrapper 注入 session id                  | ❌ 整段代码不在本 PR；复用到 follow-up PR                                                                           |
| §11 host allowlist (R3 设计)                        | ❌ 同上；整体迁移 follow-up PR                                                                                      |
| §4.4 不引入新 setting                               | ❌ **本 PR 新增 `outboundCorrelation.propagateTraceContext`** 一个 boolean；session id 相关 setting 在 follow-up PR |
| §10 future work "`X-Qwen-Code-Request-Id`"          | ✅ 仍是 future work；与 session-id follow-up 一起设计                                                               |

### 12.4 新 namespace 设计意图

`outboundCorrelation.*` 顶级 namespace 在本 PR 只有一个 boolean (`propagateTraceContext`)，看起来过度结构化。但这是**精心选择的**：

- **建立命名空间作为承诺**：让后续 session-id / request-id / etc. 自然进入这个 namespace
- **标注为 security-relevant**：`settingsSchema.ts` description 显式写 "SECURITY-RELEVANT"，文档化为"安全设置"而非"observability 设置"
- **defaults 全部 off**：符合 LazzyMan 提出的"open-source 客户端不应未经显式同意向第三方发稳定 id"原则
- **与 telemetry.\* 解耦**：用户读 settings.json 看到 `outboundCorrelation.*` 立刻能识别这是出站 wire 行为，不是 observability

#### 隐性依赖：`telemetry.enabled`

虽然 namespace 与 `telemetry.*` 解耦，**运行时生效仍依赖 `telemetry.enabled: true`** —— OTel SDK 只在 telemetry 启用时初始化，没有 SDK 就没有 propagator 安装、没有 `propagation.inject()` 调用，flag 等于沉默 no-op。容易踩的 footgun：运营商加 `propagateTraceContext: true` 却忘开 telemetry，trap server 上看不到任何 `traceparent`，无 error / 无 warning。

两个面向用户的面板都显式标注此依赖：

- `telemetry.md` 的 `propagateTraceContext` 段附完整双 flag JSON 示例
- `settingsSchema.ts` 的 description string **首句**即 "Requires `telemetry.enabled: true`"（前置以避免 VS Code 设置 UI 长描述折叠后看不到）

未来若添加 session-id header 或其他 `outboundCorrelation.*` setting，**同一依赖关系适用** —— 都得在 telemetry 启用前提下才有意义（因为它们都通过 OTel instrumentation/SDK 注入）。Follow-up PR 应继承此 footgun 提示模式。

### 12.5 实施

| 文件                                                                            | 改动                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/telemetry/llm-correlation-fetch.ts`                          | **删除**                                                                                                                                                                                                                          |
| `packages/core/src/telemetry/llm-correlation-fetch.test.ts`                     | **删除**                                                                                                                                                                                                                          |
| `packages/core/src/telemetry/trusted-llm-hosts.ts`                              | **删除**                                                                                                                                                                                                                          |
| `packages/core/src/telemetry/trusted-llm-hosts.test.ts`                         | **删除**                                                                                                                                                                                                                          |
| `packages/core/src/telemetry/sdk.ts`                                            | + `NoopTextMapPropagator`；按 `getOutboundCorrelationPropagateTraceContext()` 决定 SDK textMapPropagator                                                                                                                          |
| `packages/core/src/core/openaiContentGenerator/provider/default.ts`             | 移除 `wrapFetchWithCorrelation` 引用                                                                                                                                                                                              |
| `packages/core/src/core/openaiContentGenerator/provider/dashscope.ts`           | 同上                                                                                                                                                                                                                              |
| `packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts` | 同上                                                                                                                                                                                                                              |
| `packages/core/src/core/geminiContentGenerator/index.ts`                        | 移除 `staticCorrelationHeaders` 引用                                                                                                                                                                                              |
| 上述 4 个 provider 的 `*.test.ts`                                               | 删 session-id 相关测试 case                                                                                                                                                                                                       |
| `packages/core/src/config/config.ts`                                            | 删 `TelemetrySettings.sessionIdHeaderHosts`、`getTelemetrySessionIdHeaderHosts`；**新增 `OutboundCorrelationSettings` 接口 + `outboundCorrelationSettings` 字段 + `getOutboundCorrelationPropagateTraceContext()` getter**        |
| `packages/core/src/telemetry/config.ts`                                         | 删 `resolveTelemetrySettings` 中 sessionIdHeaderHosts 透传                                                                                                                                                                        |
| `packages/cli/src/config/settingsSchema.ts`                                     | 删 `sessionIdHeaderHosts` schema；**新增 `outboundCorrelation` 顶级 schema 项**                                                                                                                                                   |
| `packages/cli/src/config/config.ts`                                             | 透传 `outboundCorrelation: settings.outboundCorrelation` 进 `ConfigParameters`                                                                                                                                                    |
| `packages/vscode-ide-companion/schemas/settings.schema.json`                    | `npm run generate:settings-schema` 重新生成（description 后续更新时同步刷新）                                                                                                                                                     |
| `docs/developers/development/telemetry.md`                                      | 重写 "Trace context propagation" → "Client-side HTTP span on outbound fetch"；删 "Session correlation header" 整节；新增 "Outbound correlation (SECURITY-RELEVANT)" 顶级 section；附 `telemetry.enabled` 依赖说明 + JSON 配置示例 |
| `docs/design/telemetry-outbound-propagation-design.md`                          | 本节 + R4 表头 + 修订指针                                                                                                                                                                                                         |
| `packages/core/src/config/config.test.ts`                                       | **新增 `OutboundCorrelation Configuration` describe block**，`it.each` 4 个 case 锁定 `getOutboundCorrelationPropagateTraceContext` 的 default-false 安全不变性（omitted / `{}` / explicit true / explicit false）                |

### 12.6 对 LazzyMan 元论点的回应

| 论点                                            | R4 后状态                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| "Telemetry namespace 暗示自家 collector 接收方" | ✅ wire 行为已搬出 `telemetry.*`；新 `outboundCorrelation.*` namespace 显式标识"出站第三方"语义       |
| "默认行为不应未经显式同意向第三方发标识符"      | ✅ `propagateTraceContext` 默认 false；session-id 整套 follow-up PR 也将默认 off                      |
| "telemetry PR 不应偷渡 wire-level 行为"         | ✅ 本 PR 不再添加任何"telemetry 控制 wire 行为"的代码路径；wire 行为统一由 `outboundCorrelation.*` 管 |
| "split is mechanical, work isn't wasted"        | ✅ R3 落地代码物理删除自本 branch，留在 git history 里给 follow-up PR 复用（或 cherry-pick）          |

### 12.7 follow-up PR 大纲（信息性，不在本 PR 范围）

未来 follow-up PR 应包含：

- `outboundCorrelation.sessionIdHeader: { enabled, trustedHosts }` 或类似 setting
- 复用 R3 已实现的 `wrapFetchWithCorrelation` / `matchesTrustedHost` / `DEFAULT_SESSION_ID_HEADER_HOSTS` 代码骨架
- threat model 一节，明确：recipient 集合、稳定 id 的去匿名化窗口、可选 per-request UUID 配套
- **默认 off**（无 default allowlist —— 比 R3 更严，符合 LazzyMan 的开源 CLI 原则）
- security-relevant 标注 + docs/users/configuration/settings.md 收录
