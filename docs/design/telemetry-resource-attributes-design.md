---
description: "Qwen Code telemetry resource attributes design. Add custom resource labels while controlling metric cardinality for production observability."
---

# Telemetry: Custom Resource Attributes + Metric Cardinality Controls

> 配套 issue: [#4365](https://github.com/QwenLM/qwen-code/issues/4365)
> 父 issue: [#3731](https://github.com/QwenLM/qwen-code/issues/3731)
> 基于 2026-05-21 对 qwen-code main 分支的代码复核

## 1. 背景

qwen-code 已经接入 OpenTelemetry SDK，但 Resource 构造方式让它在两个常见生产场景下不可用：

1. **无法附加自定义维度**：运维侧想给所有 telemetry 数据打 `team` / `env` / `cost_center` / `user_id` 标签，今天没有任何机制可以做到。即使设置标准的 `OTEL_RESOURCE_ATTRIBUTES` 环境变量也**完全不生效**。
2. **指标基数（cardinality）失控**：`session.id` 被注入到了 Resource 层，会自动附着到每条 metric 数据点。每个 CLI session 产生一个新值，指标后端（Prometheus / 阿里云 ARMS Metric / VictoriaMetrics）会被无界 time-series 撑爆。

这两个问题耦合在一起：解决前者会让用户**更容易**给数据加高基数的字段，所以必须配套提供后者。

## 2. 现状

### 2.1 Resource 构造

`packages/core/src/telemetry/sdk.ts:156-161`：

```ts
const resource = resourceFromAttributes({
  [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
  [SemanticResourceAttributes.SERVICE_VERSION]:
    config.getCliVersion() || 'unknown',
  'session.id': config.getSessionId(),
});
```

`sdk.ts:274-278`：

```ts
sdk = new NodeSDK({
  resource,
  // Disable async host/process/env resource detectors: they leave attributes
  // pending and trigger an OTel diag.error on any resource attribute read
  // before the detectors settle (e.g. during HttpInstrumentation span creation).
  autoDetectResources: false,
  ...
});
```

`autoDetectResources: false` 关闭了标准 OTel 的 `envDetector`——也就是平时会读取 `OTEL_RESOURCE_ATTRIBUTES` 和 `OTEL_SERVICE_NAME` 的那一层。这是有原因的（detector 异步，会在 settle 前触发 `diag.error`），但副作用是这两个标准环境变量在 qwen-code 里**完全无效**。

### 2.2 `session.id` 实际是三重注入

| 位置                        | 行号                     | 影响                                  |
| --------------------------- | ------------------------ | ------------------------------------- |
| Resource                    | `sdk.ts:160`             | 所有 signal（spans / logs / metrics） |
| Per-span                    | `session-tracing.ts:169` | spans                                 |
| Per-log                     | `loggers.ts:128`         | logs                                  |
| **`getCommonAttributes()`** | `metrics.ts:57`          | **每条 metric record 显式叠加**       |

也就是说**单独把 `session.id` 从 Resource 拿掉是不够的**——`metrics.ts:57` 的 `baseMetricDefinition.getCommonAttributes()` 会被 30+ 个 metric 调用点 `...spread` 进去，再次塞回 `session.id`。

```ts
// metrics.ts:55-59
const baseMetricDefinition = {
  getCommonAttributes: (config: Config): Attributes => ({
    'session.id': config.getSessionId(),
  }),
};
```

好消息：所有 metric 调用点（30+ 个）都走这一个函数，是天然的 chokepoint。

### 2.3 config resolver 模式

`packages/core/src/telemetry/config.ts:resolveTelemetrySettings()` 用统一的优先级链：

```
argv (highest)  >  QWEN_* env  >  OTEL_* env  >  settings.json (lowest)
```

新加项照搬这个 pattern。

### 2.4 settings schema 现状

`packages/cli/src/config/settingsSchema.ts:998-1018` 定义 `telemetry` 的 JSON schema：

```ts
telemetry: {
  type: 'object',
  // ...
  jsonSchemaOverride: {
    type: 'object',
    properties: {
      includeSensitiveSpanAttributes: { ... },
    },
    additionalProperties: true,  // ← 今天对其他 telemetry.* key 不校验
  },
}
```

`additionalProperties: true` 意味着今天 schema 对 `otlpEndpoint` / `otlpProtocol` / `resourceAttributes` 等其他字段全部放行不校验。新加 `resourceAttributes` / `metrics` 字段时，应同步在这里补 schema，方便 IDE 自动补全和 settings UI 渲染。

### 2.5 不在本设计范围的代码路径

`packages/core/src/telemetry/qwen-logger/qwen-logger.ts` 是 qwen-code 的**第一方使用上报通道**（基于阿里 RUM 内部协议 `RumResourceEvent`），与 OTel SDK 完全独立。它有自己的 endpoint、proxy 和数据模型，**不受本设计影响**。详见第 3 节。

### 2.6 已支持 / 未支持的 `OTEL_*` 环境变量

| 环境变量                                            | 现状                              |
| --------------------------------------------------- | --------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                       | ✅ 支持（`config.ts:79`）         |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_ENDPOINT` | ✅ 支持                           |
| `OTEL_EXPORTER_OTLP_HEADERS`                        | ✅ 底层 exporter 直接读取         |
| `OTEL_TRACES_SAMPLER`                               | ✅ 支持（`tracer.ts:247`）        |
| **`OTEL_RESOURCE_ATTRIBUTES`**                      | ❌ 完全不支持                     |
| **`OTEL_SERVICE_NAME`**                             | ❌ 完全不支持                     |
| **`OTEL_METRICS_INCLUDE_*`**                        | ❌ 完全不支持（claude-code 风格） |

## 3. 目标 / 非目标

### 3.1 目标

- 让运维通过标准 `OTEL_RESOURCE_ATTRIBUTES` 和自家 `settings.json` 给所有 OTLP 导出的 span / log / metric 附加自定义 resource attributes
- 让 `OTEL_SERVICE_NAME` 按 OTel 规范工作（包括与 `OTEL_RESOURCE_ATTRIBUTES` 里的 `service.name` 的优先级）
- 默认情况下，metric 上**不**携带 `session.id`（保护后端基数）
- 提供显式开关让需要 metric-level session correlation 的用户重新打开
- 保留 spans 和 logs 上的 `session.id`（trace correlation 必须）
- 保留 `autoDetectResources: false`，不退化 `diag.error` 那个已修的 bug
- 配套更新 `settingsSchema.ts` 让新字段对 settings UI 和 IDE 可见

### 3.2 非目标

- **`qwen-logger` 第一方上报**：完全独立的 RUM 通道，不在本设计范围。其上报字段（device id、user agent 等）由 RUM 协议决定，不应被用户 resource attribute 干扰。若未来要给 `qwen-logger` 增加自定义维度，是另一条独立的设计。
- **Per-span 动态 attribute hook**：让用户写代码 / hook 给每个 span 计算 attribute。claude-code 也没解决这块，复杂度高、收益低。
- **`service.version` cardinality 控制**：版本变化频率有限（月级），time series 增长可控。需要时走 v2，引入 OTel View API。
- **Agent SDK 形态的 per-query resource attrs**：qwen-code 目前没有 SDK 调用场景。
- **OTLP 请求头（auth headers）配置**：是另一条 issue 线（#3731 P1），与本设计独立。
- **CLI flag 形式的 resource attribute**：env var + settings.json 已覆盖临时与基线两种场景，CLI flag 会让命令行变得啰嗦，无明显增益。

## 4. 设计

### 4.1 总体分层

```
┌─ Resource（sdk.ts:156）────────────────────────────────────────┐
│   service.name        ← OTEL_SERVICE_NAME                      │
│                          > OTEL_RESOURCE_ATTRIBUTES.service.name│
│                          > 'qwen-code'                         │
│   service.version     ← config.getCliVersion()  [reserved]     │
│   ...user attrs       ← OTEL_RESOURCE_ATTRIBUTES               │
│                          + settings.resourceAttributes         │
│   ✗ session.id 移走                                            │
└────────────────────────────────────────────────────────────────┘
       │
       ├──→ Spans     ＋ session.id（session-tracing.ts:169，保留）
       ├──→ Logs      ＋ session.id（loggers.ts:128，保留）
       └──→ Metrics   ＋ getCommonAttributes() — 默认 {}
                          toggle ON: { session.id }
```

### 4.2 优先级 / merge 顺序

#### 一般 attribute

低 → 高：

1. `OTEL_RESOURCE_ATTRIBUTES`（标准 OTel env var）
2. `settings.telemetry.resourceAttributes`
3. 内建保留键（覆盖以上任何同名）

**理由**：环境变量是 ops-time 临时覆盖（CI / 单机 debug），settings.json 是 fleet-baked 基线，内建是产品契约——基线优先级应高于临时变量，内建优先级应高于一切。

#### `service.name` 特殊处理

`service.name` 必须遵守 [OTel 规范](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)：

> **`OTEL_SERVICE_NAME` takes precedence over `service.name` defined with the `OTEL_RESOURCE_ATTRIBUTES` variable.**

因此对 `service.name` 单独应用这条优先级链（高 → 低）：

1. `OTEL_SERVICE_NAME`（最高，标准 OTel 规范规定）
2. `settings.resourceAttributes.service.name`（settings 优先于 env，沿用本设计一般规则）
3. `OTEL_RESOURCE_ATTRIBUTES.service.name`
4. 内建默认 `'qwen-code'`

`service.name` 允许通过 settings 覆盖——它是 service 身份，企业 fleet 用统一 settings.json 配置 service.name 是常见且合理的做法，禁止反而会阻断 GitOps 分发场景。`OTEL_SERVICE_NAME` 作为标准 OTel 规范规定的"最高优先级"通道，仍然可以在 CI / 单机调试时临时覆盖 settings。

具体规则：

| 来源                                                    | 写入 `service.name` 是否生效           |
| ------------------------------------------------------- | -------------------------------------- |
| `OTEL_SERVICE_NAME=foo`                                 | ✅ 最高优先级（覆盖任何其他来源）      |
| `settings.resourceAttributes={ "service.name": "foo" }` | ✅ 仅在没有 `OTEL_SERVICE_NAME` 时生效 |
| `OTEL_RESOURCE_ATTRIBUTES=service.name=foo`             | ✅ 仅在以上两者都没有时生效            |

### 4.3 保留键策略

| 键                | 用户能否覆盖                                                            | 理由                                                                                                  |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `service.name`    | ✅ env var + settings 都可（见 §4.2 优先级链）                          | service 身份，应允许 ops 控制                                                                         |
| `service.version` | ❌ 任何来源都丢弃 + warn                                                | 遥测可信度——不允许用户谎报版本                                                                        |
| `session.id`      | ❌ 任何来源都丢弃 + warn（在 metric 上额外有 toggle 控制 runtime 注入） | runtime-only；用户写到 Resource 会绕过 metric cardinality toggle（Resource attr 自动附到所有 signal） |
| `qwen.*` 前缀     | ⚠️ 不强制保留，但 docs 建议留给产品自用                                 | 避免未来内建 attr 与用户 attr 冲突                                                                    |

**保留键以常量集中维护**：

```ts
// telemetry/resource-attributes.ts (new file)
/** Keys that cannot be overridden from any source (env or settings). */
export const RESERVED_RESOURCE_ATTRIBUTE_KEYS = new Set<string>([
  'service.version',
  'session.id',
]);
```

`service.name` **不**在 RESERVED 列表里——它走自己的优先级链（§4.2），不属于"全局禁止覆盖"语义。RESERVED 是"任何来源写了都警告并丢弃"，统一适用于 env 和 settings 两个入口。

### 4.4 `OTEL_RESOURCE_ATTRIBUTES` 解析

同步实现，绕开 OTel 自带的异步 envDetector：

```ts
function parseOtelResourceAttributes(
  raw: string | undefined,
): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      diag.warn(
        `Skipping malformed OTEL_RESOURCE_ATTRIBUTES entry: ${trimmed}`,
      );
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const valueRaw = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    let value: string;
    try {
      value = decodeURIComponent(valueRaw);
    } catch {
      diag.warn(
        `Invalid percent-encoding in OTEL_RESOURCE_ATTRIBUTES for key "${key}", using raw value`,
      );
      value = valueRaw;
    }
    out[key] = value; // duplicate keys: last wins (matches OTel reference impls)
  }
  return out;
}
```

格式严格按 OTel 规范：`key1=val1,key2=val2`，值 percent-encoded。

### 4.5 Metric attribute filter

唯一改动点 `metrics.ts:55-59`：

```ts
const baseMetricDefinition = {
  getCommonAttributes: (config: Config): Attributes => {
    const out: Attributes = {};
    if (config.getTelemetryMetricsIncludeSessionId()) {
      out['session.id'] = config.getSessionId();
    }
    return out;
  },
};
```

调用点（30+ 个）零改动——`...spread` 一个空对象等价于不展开任何字段。

### 4.6 边界情况与校验

| 输入                                                             | 行为                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `OTEL_RESOURCE_ATTRIBUTES=""` (空字符串)                         | 返回 `{}`，正常启动                                                     |
| `OTEL_RESOURCE_ATTRIBUTES="a"` (无 `=`)                          | 跳过该项 + `diag.warn`，继续解析其余                                    |
| `OTEL_RESOURCE_ATTRIBUTES="=val"` (空 key)                       | 跳过该项，继续解析其余                                                  |
| `OTEL_RESOURCE_ATTRIBUTES="a=,b=2"` (空 value)                   | `a=''`, `b='2'`（OTel 规范允许空 value）                                |
| `OTEL_RESOURCE_ATTRIBUTES="a=val%ZZbad"` (无效 percent-encoding) | 保留原始 `val%ZZbad` + `diag.warn`                                      |
| `OTEL_RESOURCE_ATTRIBUTES="a=1,a=2"` (duplicate key)             | 后写胜出 `a=2`（与 OTel SDK 参考实现一致）                              |
| `OTEL_RESOURCE_ATTRIBUTES="a=1, b=2 "` (含空格)                  | 自动 trim                                                               |
| `OTEL_RESOURCE_ATTRIBUTES=service.version=x`                     | 静默丢弃 `service.version` + `diag.warn`，保留其他键                    |
| `settings.resourceAttributes={ "service.name": "x" }`            | 接受（settings 可设 service.name，见 §4.2）                             |
| `settings.resourceAttributes={ "service.version": "x" }`         | 静默丢弃 + `diag.warn`                                                  |
| `settings.resourceAttributes={ "team": 123 }` (非 string)        | TypeScript 类型阻挡；runtime 传入则 settings JSON schema validator 拒绝 |
| Resource 总大小 > OTel 限制 (4KB?)                               | 由底层 OTel SDK 处理，不在本层校验                                      |

**为什么不在本层做 attribute key 命名校验**（如 OTel 推荐的 `[a-z][a-z0-9_.]*` 模式）：OTel SDK 自己会在 export 时校验，本层重复校验既慢又容易和 SDK 行为偏移。我们只做格式解析，不做语义校验。

**RESERVED 键的强制保护对两个入口都生效**：

```ts
// 应用于 env-parsed attrs
for (const k of RESERVED_RESOURCE_ATTRIBUTE_KEYS) {
  if (k in envAttrs) {
    diag.warn(`OTEL_RESOURCE_ATTRIBUTES cannot override "${k}"; ignoring`);
    delete envAttrs[k];
  }
}

// 应用于 settings attrs
for (const k of RESERVED_RESOURCE_ATTRIBUTE_KEYS) {
  if (k in settingsAttrs) {
    diag.warn(
      `settings.telemetry.resourceAttributes cannot override "${k}"; ignoring`,
    );
    delete settingsAttrs[k];
  }
}
```

### 4.7 生命周期与多进程

- **SDK init 时机**：Resource 在 `initializeTelemetry()` 时一次性构造，**进程内不可变**。这与 OTel SDK 设计一致。
- **Subagent fork**：qwen-code 的 subagent 是同进程内的 (`subagent-runtime.ts`)，共享 Resource。若未来引入跨进程 subagent，子进程会**重新 init SDK**，重新读 env var 和 settings——只要 env 透传过去，行为一致。
- **Hot reload**：settings 修改后**不会重新构造 Resource**。需要操作员重启 CLI 才能生效。文档应明确说明。
- **`refreshSessionContext()`** (`sdk.ts:306`)：仅刷新 session ALS context，**不重建 Resource**——因为 Resource 上已经没有 `session.id` 了（本设计的核心改动之一）。

## 5. Config schema 改动

### 5.1 `TelemetrySettings` 接口（`packages/core/src/config/config.ts:293`）

```ts
export interface TelemetrySettings {
  // ... existing fields
  /** Static resource attributes attached to every span/log/metric. */
  resourceAttributes?: Record<string, string>;
  /** Per-signal cardinality controls. */
  metrics?: {
    /** Include session.id on metric data points (default: false). */
    includeSessionId?: boolean;
  };
}
```

### 5.2 `Config` getter（同文件）

```ts
class Config {
  getTelemetryResourceAttributes(): Record<string, string> {
    return this.telemetrySettings.resourceAttributes ?? {};
  }
  getTelemetryMetricsIncludeSessionId(): boolean {
    return this.telemetrySettings.metrics?.includeSessionId ?? false;
  }
}
```

### 5.3 `resolveTelemetrySettings()` 新增

```ts
const envResourceAttrs = parseOtelResourceAttributes(
  env['OTEL_RESOURCE_ATTRIBUTES'],
);
const settingsResourceAttrs = { ...(settings.resourceAttributes ?? {}) };

// Strip RESERVED keys from both sources (warn if user tried to set them).
for (const k of RESERVED_RESOURCE_ATTRIBUTE_KEYS) {
  if (k in envResourceAttrs) {
    diag.warn(`OTEL_RESOURCE_ATTRIBUTES cannot override "${k}"; ignoring`);
    delete envResourceAttrs[k];
  }
  if (k in settingsResourceAttrs) {
    diag.warn(
      `settings.telemetry.resourceAttributes cannot override "${k}"; ignoring`,
    );
    delete settingsResourceAttrs[k];
  }
}

// Merge: env < settings (settings wins on conflict).
const merged: Record<string, string> = {
  ...envResourceAttrs,
  ...settingsResourceAttrs,
};

// service.name precedence: OTEL_SERVICE_NAME (env-only escape) wins over
// everything else. settings already overwrote env in the spread above.
if (env['OTEL_SERVICE_NAME']) {
  merged['service.name'] = env['OTEL_SERVICE_NAME'];
}

const resourceAttributes = merged;

const metricsIncludeSessionId =
  parseBooleanEnvFlag(env['QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID']) ??
  settings.metrics?.includeSessionId ??
  false;

return {
  // ... existing fields
  resourceAttributes,
  metrics: { includeSessionId: metricsIncludeSessionId },
};
```

### 5.4 `sdk.ts` Resource 构造改动

```ts
const userAttrs = config.getTelemetryResourceAttributes();
// service.version is always built-in; service.name flows through userAttrs
// (it was already resolved with OTEL_SERVICE_NAME precedence in resolver).
const builtinServiceName = userAttrs['service.name'] ?? SERVICE_NAME;
const { 'service.name': _, 'service.version': __, ...nonReserved } = userAttrs;

const resource = resourceFromAttributes({
  ...nonReserved,
  [SemanticResourceAttributes.SERVICE_NAME]: builtinServiceName,
  [SemanticResourceAttributes.SERVICE_VERSION]:
    config.getCliVersion() || 'unknown',
  // session.id deliberately NOT placed on Resource — see design doc §4.1
});
```

### 5.5 `settingsSchema.ts` 改动

`packages/cli/src/config/settingsSchema.ts:998-1018` 的 `telemetry.jsonSchemaOverride.properties` 加：

```ts
{
  // ... existing includeSensitiveSpanAttributes
  resourceAttributes: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Static resource attributes attached to all telemetry data. ' +
      'Keys must be strings; values must be strings. ' +
      'Reserved keys (service.name, service.version) are silently dropped.',
    default: {},
  },
  metrics: {
    type: 'object',
    additionalProperties: false,
    properties: {
      includeSessionId: {
        type: 'boolean',
        default: false,
        description:
          'Include session.id on every metric data point. ' +
          'WARNING: each CLI session creates a new value, causing unbounded ' +
          'metric time-series fan-out. Only enable for short-term debugging.',
      },
    },
  },
}
```

也要把 `additionalProperties: true` 重新评估——目前是 permissive，可以保留也可以转 strict。建议保留 permissive，避免对其他未在 schema 中声明的 `telemetry.*` 字段产生破坏性变更，但 docs 里明确"未声明字段会被忽略"。

## 6. 文件改动清单

| 文件                                                           | 改动                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/core/src/telemetry/sdk.ts`                           | 改 Resource 构造（合并 user attrs，删 `session.id`）                       |
| `packages/core/src/telemetry/resource-attributes.ts` (新文件)  | `parseOtelResourceAttributes()` + `RESERVED_RESOURCE_ATTRIBUTE_KEYS` 常量  |
| `packages/core/src/telemetry/config.ts`                        | resolver 加 `resourceAttributes` + `metrics.includeSessionId` 解析与 merge |
| `packages/core/src/telemetry/metrics.ts`                       | `getCommonAttributes()` 加 toggle gate                                     |
| `packages/core/src/config/config.ts`                           | `TelemetrySettings` schema + 两个 getter                                   |
| `packages/cli/src/config/settingsSchema.ts`                    | `jsonSchemaOverride` 加 `resourceAttributes` + `metrics`                   |
| `docs/developers/development/telemetry.md`                     | 加 "Resource attributes" + "Cardinality controls" 两节 + 迁移说明 + 示例   |
| `packages/core/src/telemetry/resource-attributes.test.ts` (新) | 解析器单元测试（覆盖 §4.6 全部用例）                                       |
| `packages/core/src/telemetry/sdk.test.ts`                      | merge 优先级 / 保留键 / `OTEL_SERVICE_NAME`                                |
| `packages/core/src/telemetry/metrics.test.ts`                  | toggle off/on 时 `session.id` 出现与否                                     |
| `packages/core/src/telemetry/config.test.ts`                   | env / settings 合并                                                        |
| `CHANGELOG.md` 或 release notes                                | PR 2 的 breaking change 说明                                               |

## 7. 分 PR 拆分

按 review 友好性与 blast radius 分三个 PR：

### PR 1 — Custom resource attributes（additive，零破坏）

- 新文件 `resource-attributes.ts`：`parseOtelResourceAttributes()` + `RESERVED_RESOURCE_ATTRIBUTE_KEYS`
- `TelemetrySettings.resourceAttributes` 字段 + resolver merge 逻辑
- `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` 接入，按 §4.2 优先级
- 合并进 Resource（`sdk.ts`）
- `settingsSchema.ts` 加 `resourceAttributes` JSON schema
- **不动** `session.id` 在 Resource 上的位置
- Docs 加 "Resource attributes" 一节

**风险**：低。完全 additive，不改任何现有行为。除非用户主动设置环境变量或 settings，否则导出的数据无变化。

### PR 2 — Cardinality controls（semantic break）

- 从 Resource 删 `session.id` (`sdk.ts:160` 那一行)
- 加 `metrics.includeSessionId` toggle（settings + env）+ `getCommonAttributes()` gate
- `settingsSchema.ts` 加 `metrics` JSON schema
- CHANGELOG / 迁移说明
- 快照测试锁定 metric attribute 集合（防回归）
- Docs 加 "Cardinality controls" 一节 + 迁移指南

**风险**：中等。任何依赖 metric 上 `session.id` 的 Prometheus query / Grafana dashboard / 告警规则会失效。需要显式 release note 与 1-2 个版本的迁移窗口。

**Opt-in 过渡方案**（候选，本期建议**不采用**）：

> PR 2 可先以"opt-out"形式落地——默认仍把 `session.id` 注入 metric，但加 warn log "this default will flip in v0.X"。一个 release 后再翻转默认。

不建议采用的原因：（1）当前 qwen-code 用户群不大，破坏面有限；（2）这是 cardinality bug，越早默认安全越好；（3）双段式发布会增加文档负担。如果父 issue owner 想要保守一些，可以采纳。

### PR 3 — Docs polish + samples（cleanup）

- `docs/developers/development/telemetry.md` 补示例（见 §10）
- 阿里云 ARMS / Prometheus / Grafana 接入示例
- 把所有典型 use case 的 settings.json 片段加进去

## 8. 测试计划

### 8.1 `parseOtelResourceAttributes()` 单元测试

参数化覆盖 §4.6 表格全部行（建议用 vitest `it.each`）：

```ts
it.each([
  ['', {}],
  ['a=1', { a: '1' }],
  ['a=1,b=2', { a: '1', b: '2' }],
  ['a=hello%20world', { a: 'hello world' }],
  ['a=val%ZZbad', { a: 'val%ZZbad' }], // invalid percent
  ['malformed', {}],
  ['=val', {}],
  ['a=', { a: '' }],
  ['a=1,a=2', { a: '2' }],
  [' a = 1 , b = 2 ', { a: '1', b: '2' }],
])('parses %j → %j', (input, expected) => {
  expect(parseOtelResourceAttributes(input)).toEqual(expected);
});
```

### 8.2 Resolver merge 测试

| 场景                                                                    | 期望 `service.name`                                   | 期望 user attr                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| 全空                                                                    | `'qwen-code'`                                         | 不存在                               |
| 仅 env `OTEL_SERVICE_NAME=A`                                            | `'A'`                                                 | —                                    |
| 仅 env `OTEL_RESOURCE_ATTRIBUTES=service.name=B`                        | `'B'`                                                 | —                                    |
| `OTEL_SERVICE_NAME=A` + `OTEL_RESOURCE_ATTRIBUTES=service.name=B`       | `'A'`（OTEL_SERVICE_NAME 优先）                       | —                                    |
| `OTEL_SERVICE_NAME=A` + `settings={service.name:C}`                     | `'A'`（OTEL_SERVICE_NAME 优先）                       | —                                    |
| `OTEL_RESOURCE_ATTRIBUTES=service.name=B` + `settings={service.name:C}` | `'C'`（settings 优先于 env，无 OTEL_SERVICE_NAME 时） | —                                    |
| `OTEL_RESOURCE_ATTRIBUTES=team=x` + `settings={team:y}`                 | `'qwen-code'`                                         | `team='y'`（settings 优先）          |
| `OTEL_RESOURCE_ATTRIBUTES=service.version=fake`                         | `'qwen-code'` + warn                                  | service.version 仍为真实 cli version |
| `settings={service.version:fake}`                                       | `'qwen-code'` + warn                                  | service.version 仍为真实 cli version |

### 8.3 Resource 内容快照测试

用 `InMemorySpanExporter` 拿一个 span，断言：

```ts
expect(span.resource.attributes['service.name']).toBe('qwen-code');
expect(span.resource.attributes['service.version']).toBe(EXPECTED_VERSION);
expect(span.resource.attributes['session.id']).toBeUndefined(); // 关键
expect(span.resource.attributes['team']).toBe('platform'); // 用户加的
```

### 8.4 Metric attribute toggle 测试

```ts
it('does not emit session.id on metrics by default', async () => {
  // emit one tool call counter
  recordToolCallMetrics(...);
  const data = await metricReader.collect();
  const dp = data.resourceMetrics.scopeMetrics[0].metrics[0].dataPoints[0];
  expect(dp.attributes['session.id']).toBeUndefined();
});

it('emits session.id when toggle is true', async () => {
  config.telemetrySettings.metrics = { includeSessionId: true };
  recordToolCallMetrics(...);
  const data = await metricReader.collect();
  const dp = data.resourceMetrics.scopeMetrics[0].metrics[0].dataPoints[0];
  expect(dp.attributes['session.id']).toBe(KNOWN_SESSION_ID);
});
```

### 8.5 Spans / Logs 行为保持测试

- spans 仍有 `session.id`（不受 metric toggle 影响）
- logs 仍有 `session.id`（不受 metric toggle 影响）

### 8.6 回归保护

- `autoDetectResources: false` 保持不变（assertion on config）
- 启动期间不出现新增 `diag.error`（捕获 OTel diag 日志做 assertion）
- 现有所有 telemetry 测试通过（CI）

### 8.7 Diag warn 测试

校验下列输入都触发 `diag.warn` 一次：

- `settings.resourceAttributes = { 'service.version': 'x' }`（reserved）
- `OTEL_RESOURCE_ATTRIBUTES=service.version=x`（reserved，env 也要 warn）
- `OTEL_RESOURCE_ATTRIBUTES=malformed`（无 `=`）
- `OTEL_RESOURCE_ATTRIBUTES=a=val%ZZ`（无效 percent-encoding）

校验下列输入**不**触发 warn（合法路径）：

- `settings.resourceAttributes = { 'service.name': 'x' }`（settings 允许设 service.name）
- `OTEL_SERVICE_NAME=foo` + `settings.resourceAttributes = { 'service.name': 'bar' }`（OTEL_SERVICE_NAME 优先即可，不需要 warn）

## 9. 迁移 / 破坏性变更

### 9.1 破坏性变更（PR 2）

**指标上的 `session.id` 默认消失**。这会影响：

- Prometheus query 中 `by (session_id)` / `group_left(session_id)` 的聚合
- Grafana dashboard 中按 session 切片的图
- 任何按 session.id 做告警分组的规则

注：spans 和 logs 上的 `session.id` **不受影响**。

### 9.2 迁移路径

文档里给两个选项：

**选项 A**：恢复旧行为（短期 debug 推荐）

```bash
export QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true
```

或 `settings.json`：

```json
{
  "telemetry": {
    "metrics": { "includeSessionId": true }
  }
}
```

⚠️ **警告**：长期开启会让 metric time-series 数量 = 历史 session 数量，撑爆后端。仅短期 debug 用。

**选项 B**：改用 spans / logs 做 session 切片（推荐）

- spans / logs 上仍有 `session.id`，可在 trace backend（如 Jaeger / Aliyun ARMS Tracing）/ log backend（如 Loki / SLS）按 session 切片
- 这两类数据本来就是 per-event 存储，cardinality 不会爆炸
- 适合做 session-level drill-down 分析

### 9.3 Release note 模板

```
**Breaking change (metric attribute):**

The `session.id` attribute is no longer attached to metric data
points by default. This protects metric backends from unbounded
time-series fan-out.

- Spans and logs are unaffected — `session.id` is still present.
- To restore the previous behavior (short-term debugging only), set
  `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true` or in settings.json:
  `telemetry.metrics.includeSessionId: true`.
- For long-term session correlation, query against trace / log
  backends instead of metric backends.

See docs/developers/development/telemetry.md "Migration" for details.
```

## 10. 示例配置（用于文档）

### 10.1 按 team / env 切片所有 telemetry

```bash
export OTEL_RESOURCE_ATTRIBUTES="team=platform,env=prod,cost_center=eng-123"
```

效果：所有 span / log / metric 都带 `team=platform` `env=prod` `cost_center=eng-123`。

### 10.2 用 `OTEL_SERVICE_NAME` 在共享 collector 中路由

```bash
export OTEL_SERVICE_NAME=qwen-code-ci
```

效果：`service.name=qwen-code-ci`，多租户 OTel collector 可按 service.name 路由到不同后端。

### 10.3 Fleet baseline + 单机 override

公司 fleet 的 `~/.qwen/settings.json`（GitOps 分发）：

```json
{
  "telemetry": {
    "resourceAttributes": {
      "deployment.environment": "production",
      "service.namespace": "engineering-tooling"
    }
  }
}
```

单机 ops 临时覆盖（不修改 settings）：

```bash
export OTEL_RESOURCE_ATTRIBUTES="debug_run=true"
# settings 里的 deployment.environment / service.namespace 仍然生效
# 同时这次运行额外带 debug_run=true
```

### 10.4 短期 debug 打开 metric session.id

```bash
# 一次性 debug run
QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true qwen "投资分析"
```

完事即关闭，不要持久化到 settings。

### 10.5 阿里云 ARMS Metric 接入（推荐配置）

```json
{
  "telemetry": {
    "enabled": true,
    "otlpEndpoint": "http://<arms-endpoint>/api/v1/...",
    "otlpProtocol": "http",
    "resourceAttributes": {
      "team": "platform",
      "deployment.environment": "production"
    },
    "metrics": {
      "includeSessionId": false
    }
  }
}
```

## 11. 与 claude-code 实现的对比

| 维度                       | claude-code                                      | qwen-code 本设计                                 | 决策依据                                           |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------- |
| 标准 OTel env var          | `OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME` | ✅ 一致                                          | 标准契约                                           |
| `OTEL_SERVICE_NAME` 优先级 | 遵守 OTel 规范                                   | ✅ 遵守                                          | spec 明确规定                                      |
| Cardinality 开关命名       | `OTEL_METRICS_INCLUDE_*`                         | `QWEN_TELEMETRY_METRICS_INCLUDE_*`               | 不污染标准 OTel 命名空间                           |
| 开关作用域                 | 仅 metric                                        | ✅ 仅 metric                                     | spans / logs 是 per-event，无 cardinality 爆炸问题 |
| 默认值                     | 高基数 attribute 默认 false                      | ✅ 默认 false                                    | 安全优先                                           |
| Per-attribute granularity  | 每 attribute 一个 toggle                         | ✅ 一致                                          | 灵活，符合实际诊断需求                             |
| settings.json 等价物       | ❌ 无                                            | ✅ 有 `telemetry.resourceAttributes` + `metrics` | 企业 fleet 部署 base config                        |
| Per-span 动态 hook         | ❌ 无                                            | ❌ 无                                            | 复杂度高，claude-code 也没解，本期不做             |
| 多租户 `account_uuid`      | 有                                               | ❌ 无                                            | qwen-code metric 里没有此 attr                     |
| Agent SDK `options.env`    | 有                                               | ❌ 无                                            | qwen-code 没有等价模式                             |
| 保留键策略                 | 不允许覆盖 built-in id                           | ✅ 一致                                          | 遥测可信度                                         |
| 第一方上报通道             | claude-code 也有独立第一方通道（与 OTel 隔离）   | ✅ qwen-logger 同样隔离                          | 第一方与第三方通道职责分离                         |

**最值得借的两点**：

1. **命名约定**：`*_INCLUDE_*` 一眼能看出语义，比反义命名（`*_EXCLUDE_*` / `*_DROP_*`）清晰
2. **范围克制**：只 gate metric，不 gate span/log——claude-code 显然踩过这个边界，我们直接受益

**qwen-code 做得更好的点**：

- settings.json 支持：claude-code 完全靠 env var，对企业 fleet 场景不友好
- 明确的保留键策略（`service.version` 不可覆盖）：减少遥测被污染的可能
- 第一方上报隔离：qwen-logger 走独立通道，与用户 OTLP 设置完全解耦

## 12. 未来工作（v2 + 候选）

- **`service.version` cardinality 控制**：用 OTel View API 在 metric 层 drop attribute
- **更多 cardinality toggle**：未来若 metric 上引入 `user.account_uuid` / `model` 等，按需补 toggle
- **Per-span 动态 attribute hook**：可借鉴 qwen-code 自家 hooks 系统，加 `OnSpanStart(span, context) => attrs` 回调。需要独立设计。
- **Resource attribute schema 校验**：限制 key 命名空间（如禁止覆盖 `service.*` 前缀以外的内建 attr），目前靠保留键列表硬编码够用。
- **Hot reload Resource**：当 settings.json 在进程内被修改（设想 qwen-serve daemon 场景），目前不会重建 Resource。若 daemon 场景成熟，可以增加一条 reload 路径。
- **跨进程 subagent context 传播**：subagent 跨进程时，把 parent 的 trace context（包括 resource）通过 OTel context propagation 标准 header 传过去。需要独立设计。
