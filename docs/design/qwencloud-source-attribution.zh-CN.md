# 千问云来源标识请求头

[English](qwencloud-source-attribution.md) | [简体中文](qwencloud-source-attribution.zh-CN.md)

## 状态

已实现，已用真实的千问 AI 平台 Token Plan 端点验证。

## 问题

千问 AI 平台（国内站）和 QwenCloud（国际站）通过 `X-DashScope-Source-Config` 请求头，把模型调用量归到具体的 Agent。平台的接入指南要求每个 Agent 在每次模型请求中都带上这个头，值为单行 JSON：

```json
{
  "channel": "qwencloud-inner-agents",
  "source": "model",
  "tags": { "t1": "qoder", "t2": "payg" }
}
```

Qwen Code 目前不发送这个头，所以它在这两个平台上的调用量无法归到 Qwen Code 名下。

## 请求头取值

| 字段      | 取值                                                                 |
| --------- | -------------------------------------------------------------------- |
| `channel` | 国内站为 `qianwenai-inner-agents`，国际站为 `qwencloud-inner-agents` |
| `source`  | `model`                                                              |
| `tags.t1` | `qwen-code`，不随版本变化                                            |
| `tags.t2` | 按量付费端点为 `payg`；Token Plan 端点不填                           |

站点根据请求的 host 判断。`inner-agents` 是暂定值：接入指南没有对 Qwen Code 归类，这里是根据 Qwen Code 由阿里运营的 QwenLM 组织发布推断的，与指南中 `inner` 示例里的 `qoder` 情况相同。该取值待与平台确认（见待确认问题）；若改为 `outer-agents`，只需修改两处 channel 字符串。

## 范围

只有当请求的 host 精确等于下面之一时，才发送这个头：

| Host                               | `channel`                | `t2`   |
| ---------------------------------- | ------------------------ | ------ |
| `maas.qianwenaiapi.com`            | `qianwenai-inner-agents` | `payg` |
| `token-plan.maas.qianwenaiapi.com` | `qianwenai-inner-agents` | 不填   |
| `maas.qwencloudapi.com`            | `qwencloud-inner-agents` | `payg` |
| `token-plan.maas.qwencloudapi.com` | `qwencloud-inner-agents` | 不填   |

其他所有端点都保持不变，包括百炼（`dashscope.aliyuncs.com`、`*.maas.aliyuncs.com`、Coding Plan）和 Qwen OAuth 端点。是否发送只看 host，不检查 API Key。

默认配置下能打到这些 host 的请求链路有三条，三条都会发送这个头：

1. Chat Completions，经由 DashScope provider 的请求头。覆盖主会话、子 agent、fast model、上下文压缩和 vision bridge。
2. Responses API 链路。
3. WebSearch 侧信道请求，QwenCloud 预设默认开启。

## 设计决策

- **精确匹配 host。** 先解析 URL，再精确比较 hostname，所以仿冒域名（`maas.qwencloudapi.com.evil.example`）和把域名放在路径里的写法都不会命中。忽略大小写和端口。这里刻意比消费同一份列表的两个端点门禁更窄：`isDashScopeProvider` 和 WebSearch 的端点检查都按后缀匹配 `QWENCLOUD_MAAS_HOSTS`，所以不在上表里的 MaaS 子域会被当成 DashScope 服务、也能通过搜索门禁，但不带来源标识。准入只需要选对 API 方言；来源标识会把 `channel`/`t2` 写进平台面板，因此只覆盖上表列出的四个 host。
- **Token Plan 不填 `t2`。** Token Plan 的个人版和团队版 key 都以 `sk-sp-` 开头，客户端分不出来。接入指南说明平台可以按 API Key 反查付费方式，不填可以避免错报。
- **第一方取值优先。** `customHeaders` 中同名的项（不区分大小写）会被移除，所以来源标识既不会被覆盖，也不会重复发送。移除时刻意不给提示：这是文档化的策略、没有开关，请求本身照常成功。
- **不加配置项。** 取值完全由 host 推导，没有需要用户配置的内容。
- **单一 leaf 模块。** `packages/core/src/core/dashscope-source-config.ts` 不依赖任何模块，并维护 `QWENCLOUD_MAAS_HOSTS`（由 DashScope provider 再导出），provider、Responses 链路和 WebSearch 都可以引用它，不会形成循环依赖。这个 leaf 不是两个 host 字符串的唯一副本：`telemetry/gen-ai-provider.ts` 仍按自己的字面量分类，`core/reasoning-overrides.ts` 用一段内联正则。本 PR 不做合并——两个文件都不在本次改动范围内——但 leaf 已经消掉了 `gen-ai-provider.ts` 注释里所说的循环依赖，合并因此成了一个普通的后续项。`providers/presets/` 下的四个 preset base URL 也内嵌同一批 host，并有测试把它们钉在 `SITE_CHANNELS` 上。
- **按配置的 host 判断，而非运行时 host。** 判断依据是配置的 `baseUrl`。Qwen OAuth 会在运行时替换客户端的端点，但它配置的 `baseUrl` 是无法解析的占位符 `DYNAMIC_QWEN_OAUTH_BASE_URL`，因此永远不会带上来源标识；有测试固定这一点。

## 不在范围内

- **模型发现。** QwenCloud 预设列出模型时，`GET {baseUrl}/models` 会打到这些 host，但它不是模型调用，而接入指南要求标识的是模型调用。
- **Batch。** Batch 任务由平台在后台异步执行，提交请求上带的头能否计入后续的模型调用，尚未确认。
- **omni 媒体工具。** 属于实验功能，默认关闭。caption、OCR 和转写工具默认打百炼。在 QwenCloud 模型上开启 omni 时，旧版临时上传通道会复用该模型的端点；它用于上传媒体，不带来源标识。
- **Responses embeddings。** Responses 生成器的 embedding 客户端只发送 `customHeaders`；目前产品中没有任何地方调用它。
- **语音转写和 Qwen Live。** 它们的端点校验不接受 QwenCloud 的 host。
- **Anthropic 协议。** 没有 QwenCloud 预设使用它；用户手动配置、指向这些 host 的 Anthropic 条目不会带上来源标识。
- **代理。** 经由代理 host（如 `DASHSCOPE_PROXY_BASE_URL`）发出的请求不会带上来源标识，因为客户端看不到真实的平台 host。

以上链路将来能打到 QwenCloud 时，调用 `withDashScopeSourceConfig` 即可接入。

## 风险

- 如果某个网关会拒绝未知请求头，请求会失败。为此范围只限于平台自己的 host；真实端点已确认接受这个头。
- 头里不含任何用户、会话或请求数据。

## 验证

- 单元测试覆盖 host 矩阵（两个站点、两种付费方式、大小写和端口、仿冒域名和路径中的域名、百炼域名），以及对冲突 `customHeaders` 的优先级。
- 三条链路各有一个测试，断言请求 QwenCloud 端点时带上了这个头；关闭注入后三个测试全部失败。
- 向 `token-plan.maas.qianwenaiapi.com` 发出的真实请求，带头和不带头都返回 HTTP 200。
- 在 HTTP 客户端层观察一次真实的 CLI 运行：发往 Token Plan host 的请求恰好带一个头；同一会话中发往百炼 workspace host 的请求不带。

## 待确认问题

- Qwen Code 应归为阿里系内部 Agent（`inner-agents`）还是外部生态 Agent（`outer-agents`）。接入指南要求各 Agent 团队在接入前确认归属，且没有列出 Qwen Code；它引用的上游埋点方案可能定义了规则，但无法访问。
- `qwen-code` 是否需要先在平台的渠道清单中登记，才会被计入统计。
- Token Plan 端点不填 `t2` 是否为平台所接受。
- Batch 提交请求上的头能否传递到该批次的模型调用。
