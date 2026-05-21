# Telemetry: Outbound Trace Context & Session ID Header Propagation

> 配套 issue: [#4384](https://github.com/QwenLM/qwen-code/issues/4384)
> 父 issue: [#3731](https://github.com/QwenLM/qwen-code/issues/3731) (P3 deeper observability)
> 前置 PR: #4367 (resource attributes — merged 2026-05-21, commit `64401e1`)
> 基于 2026-05-21 对 qwen-code main 分支 + 直接验证的 claude-code 源码

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
- 所有 outbound LLM 请求带 `X-Qwen-Code-Session-Id` header（claude-code 同款产品命名空间）
- 自动避免对 OTLP exporter endpoint 自身的 trace（feedback loop）
- 给 LLM 请求加一层精确的 client span（网络耗时 vs 模型耗时分离）
- 覆盖 4 个 provider 构造点：OpenAI 基类、DashScope override、Gemini、Anthropic
- streaming 请求 / proxy 模式 / 重试场景全部不退化
- 与 #4367 的设计哲学一致：通过 `defaultHeaders` 这种 SDK-native 选项，不引入 fetch wrapper

### 3.2 非目标

- **`baggage` header**：标准 SDK 已支持，但 qwen-code 没调 `propagation.setBaggage()`，默认不会发送。本设计不主动开启。
- **subprocess `TRACEPARENT` env var 继承**：claude-code 给 Bash/PowerShell 子进程注入 `TRACEPARENT`。qwen-code 的 `BashTool` 没做。是独立 follow-up sub-issue。
- **inbound `TRACEPARENT` / `TRACESTATE` 读取**：claude-code 的 `-p` 模式和 Agent SDK 从 env 读 traceparent 接续父进程 trace。qwen-code 没做。独立 follow-up。
- **`X-Qwen-Code-Request-Id`**：claude-code 有 `x-client-request-id`，对超时容错 correlation 有用。本期不做，可作为下一个 sub-issue。
- **自定义 propagator（B3 / Jaeger / X-Ray）**：默认 W3C 已覆盖 99% 场景。可作为 future config option。
- **per-endpoint 选择性注入**：claude-code 对第三方 endpoint (Bedrock / Vertex) 不发 traceparent；qwen-code 没有第三方区分需要，统一发即可。

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

**几乎为零**。本设计不引入新 setting，因为：

- `traceparent` 注入由 telemetry enabled 触发（已有 toggle）
- `X-Qwen-Code-Session-Id` 注入也由 telemetry enabled 触发
- `ignoreRequestHook` 的 OTLP url 已经从现有 config 读

未来可以加的 setting（**out of scope**）：

- `telemetry.outboundCorrelationHeader`: 自定义 header name（默认 `X-Qwen-Code-Session-Id`）
- `telemetry.outboundPropagationDisabled`: 全局关闭（如果 LLM 服务对未知 header 严格）

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

| 维度                         | claude-code                                                                                                                                          | qwen-code 本设计                                                                                                                            | 决策依据                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Session id header 命名       | `X-Claude-Code-Session-Id`（产品前缀）                                                                                                               | `X-Qwen-Code-Session-Id`（产品前缀）                                                                                                        | ✅ 同样命名空间策略                                                                                                |
| Session id 注入机制          | SDK `defaultHeaders`（`client.ts:108`）+ 自定义 `buildFetch()` wrapper（`client.ts:370-390`，per-request `randomUUID()` 注入 `x-client-request-id`） | OpenAI/Anthropic 走 fetch wrapper（per-request 读 session id，避免 `/clear` staleness）；Gemini 走 static `httpOptions.headers`（SDK 限制） | 与 claude-code 的 fetch wrapper 模式对齐。claude-code 也用 fetch wrapper 才能 per-request 加 `x-client-request-id` |
| Session id 持久性            | claude-code 没有 `/clear`-式 session reset；session = process                                                                                        | 有 `/clear` reset → fetch wrapper 路径自动跟随；static headers 路径会 stale（§8.6）                                                         | qwen-code 独有的复杂度                                                                                             |
| Session id 编码              | HTTP header（不是 baggage）                                                                                                                          | HTTP header                                                                                                                                 | ✅ 同——backend 友好                                                                                                |
| `traceparent` 注入           | 闭源；公开 docs 描述存在；开源 repo 无 `propagation.inject` / `UndiciInstrumentation` 引用                                                           | `@opentelemetry/instrumentation-undici` 自动                                                                                                | claude-code 怎么实现的不可见。我们选 OTel 官方推荐路径，更轻                                                       |
| `traceparent` 发送范围       | 仅第一方 Anthropic API；不发 Bedrock/Vertex/Foundry                                                                                                  | 发给所有 LLM provider                                                                                                                       | qwen-code 没有"第一方/第三方"区分                                                                                  |
| `x-client-request-id` (随机) | 有，自动                                                                                                                                             | 暂不做（独立 follow-up sub-issue 价值更高）                                                                                                 | 范围控制                                                                                                           |
| 子进程 `TRACEPARENT` env     | 文档承认存在（实现闭源）                                                                                                                             | 不做（独立 follow-up）                                                                                                                      | 范围控制                                                                                                           |
| 入站 `TRACEPARENT` 读取      | 文档承认存在（`-p` / Agent SDK 模式）                                                                                                                | 不做（独立 follow-up）                                                                                                                      | 范围控制                                                                                                           |

**verified vs documented 注解**：

| claim                                           | 验证状态                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Claude-Code-Session-Id` via `defaultHeaders` | ✅ Open source `src/services/api/client.ts:108` 已读                                                                                              |
| `x-client-request-id` via fetch wrapper         | ✅ Open source `src/services/api/client.ts:370-390` 已读                                                                                          |
| `traceparent` 注入                              | ⚠️ 仅 docs.claude.com/docs/en/monitoring-usage.md 提到；开源 repo `grep -rn "propagation\.inject\|UndiciInstrumentation\|traceparent" src` 返回空 |

## 10. 未来工作

挂在 #3731 P3 下，本设计**不**包含但与之相关：

- **`X-Qwen-Code-Request-Id`** 随机 UUID per request（claude-code 等价：`x-client-request-id`）。对超时/timeout error correlation 有用——超时时服务端可能还没 assign request id，客户端先发的 id 是唯一关联手段。
- **子进程 `TRACEPARENT` env**：给 `BashTool` 执行子进程时注入 env，让外部工具能续传 trace。需要单独看 tool execution lifecycle。
- **入站 `TRACEPARENT`**：`--prompt` 模式启动时读 env，让 CI / 外部 orchestrator 能把 qwen-code 接到更大的 trace。
- **可配置 `correlationHeader` name**：让企业 ops 自定义 header（默认 `X-Qwen-Code-Session-Id`）。
- **`baggage` propagation 策略**：是否主动 set baggage 让 `user.id` / `tenant.id` 等也走 baggage 传到下游。本期不做，等需求明确。
