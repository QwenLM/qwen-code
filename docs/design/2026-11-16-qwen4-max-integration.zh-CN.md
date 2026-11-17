# Qwen4-Max 接入

[English](2026-11-16-qwen4-max-integration.md) | [简体中文](2026-11-16-qwen4-max-integration.zh-CN.md)

- 状态：已实现（本次变更）
- 日期：2026-11-16
- 范围：`packages/core`、`packages/cli`、设置 schema、用户文档

## 问题陈述

`qwen4-max` 是 Qwen 家族最新旗舰原生多模态模型。ModelStudio GTM 一页纸
（§3.1「API 变更」）列出了相对 `qwen3.8-max` 的七项 API 级变化。Qwen Code 已经
把 `qwen4*` 前缀接入 tiered `reasoning_effort` 线协议门与 1M 上下文窗口
（#15987），但该模型尚不可完整使用：effort 档位与默认值错误、输出 token 预算
仍按旧 `max_tokens` 语义 sizing、未声明图像/视频输入、缺少新的显式缓存 TTL 与
图像 `detail` 控制。

本设计让 `qwen4-max` 在四个通道成为一等模型：ModelStudio Standard（DashScope
按量付费）、Token Plan、QwenCloud Standard、Qwen 订阅（OAuth）。

## 七项 §3.1 变更及其处置

| #   | 变更                          | qwen4-max 行为                                                                                                                                                       | 处置                                     |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | `reasoning_effort`            | 原生档位 `low`/`high`/`xhigh`；**默认 `high`**（原为 `xhigh`）。服务端映射 `minimal→low`、`medium→high`、`max→xhigh`；`none` 关闭思考。                              | 本次                                     |
| 2   | 显式缓存 TTL                  | Chat Completions、Responses、Anthropic 支持 `5m`/`1h`。`5m` 写入按 1.25x 输入计费，`1h` 按 2x。                                                                      | 本次                                     |
| 3   | CoT 摘要                      | `thinking_display:"summarized"` 返回摘要及须原样回传的 `encrypted_content`。默认关闭（完整 CoT）。                                                                   | 延后                                     |
| 4   | `max_tokens`                  | 等同 `max_completion_tokens`；上限为**思考+回复总和**。思考上限 262,144；非思考 131,072。                                                                            | 本次                                     |
| 5   | 参数默认值                    | 思考模式 `temperature` 对文本/图像/视频均默认 `1.0`（无 0.6 下限）；非思考 `0.7`。                                                                                   | 无需改码（客户端不注入默认 temperature） |
| 6   | ptc（programmatic tool call） | 模型在代码沙箱中调用工具；加白可用。                                                                                                                                 | 延后                                     |
| 7   | 图像/视频理解                 | Chat Completions 默认 `detail:"high"`（约 16,384 image token，16,777,216 像素）；`detail:"low"` 回退到 2,621,440 像素（约 2,560 token）。Responses 不支持 `detail`。 | 本次                                     |

## 现状

- `core/src/core/tokenLimits.ts`：`PATTERNS` 有 `[/^qwen4/, LIMITS['1m']]`
  （输入）。`OUTPUT_PATTERNS` **无** `qwen4` 行，输出落到
  `[/^qwen/, LIMITS['32k']]`。`defaultOutputCeiling` 把自动请求夹到
  `OUTPUT_TOKEN_CEILING`（64K），仅 `CLAUDE_OPUS_EXTENDED` 豁免。
- `core/src/core/modalityDefaults.ts`：`isTieredEffortQwenPrefix` 匹配
  `qwen4*` 与 `qwen-latest-series-invite-*`；`isTieredEffortWireModel` 接纳
  它们。`MODALITY_PATTERNS` **无** `qwen4` 行，模态落到
  `[/^qwen/, {}]`（纯文本）。
- `core/src/core/openaiContentGenerator/pipeline.ts`：tiered 家族的规范关闭
  形状是 `reasoning_effort:'none'`；订阅分支（约 1653 行）则把 effort 映射成
  `thinking_budget`（`low:4096, medium:16384, high:32768, xhigh:32768,
max:32768`）加 `enable_thinking`。
- `core/src/core/openaiContentGenerator/provider/dashscope.ts`：
  `buildQwenEffortConfig` 为 tiered 家族发送顶层 `reasoning_effort`；注入
  `preserve_thinking:true`；缓存断点标记 `cache_control:{ type:'ephemeral' }`
  （无 `ttl`）；`clampTieredEffort` 对未声明路由使用
  `DASHSCOPE_TIERED_EFFORTS`（`low/medium/high/xhigh`）。
- `cli/src/acp-integration/model-configuration.ts`：`MODEL_CONFIGURATIONS` 有
  `qwen3.8-max`/`qwen3.8-flash`（`['low','medium','xhigh']`，默认 `xhigh`）。
  `getModelConfiguration` 对任意 tiered Qwen 前缀回退到
  `MODEL_CONFIGURATIONS['qwen3.8-max']`，故 `qwen4*` 当前继承了错误的档位与
  默认值。
- preset `alibaba-standard.ts`、`alibaba-token-plan.ts`、
  `qwencloud-standard.ts`：无 `qwen4-max` 条目。ModelStudio Standard 与
  QwenCloud 有 `supportsModelDiscovery:true`，故服务端提供的 `qwen4-max` 会经
  `/models` 出现，但无声明的 capabilities。
- `core/src/core/openaiContentGenerator/converter.ts`：输出
  `image_url:{ url }` 不带 `detail`；跨轮保留 `reasoning_content`，但不捕获
  chat-completions 的 `encrypted_content`。
- 设置：`generationConfig.cacheRetention:'ephemeral'|'1h'` 已存在（以 Anthropic
  命名），并经 `config.ts` 透传进 `contentGeneratorConfig`。

## 目标

1. `qwen4-max` 在四个通道均可选，effort 档位正确（`low`/`high`/`xhigh`）、
   默认 `high`、`none` 关闭思考。
2. 输出 token 预算反映 `max_tokens` = 思考+回复，使思考不会挤占回复。
3. 声明图像与视频输入并送达线协议。
4. 显式缓存 TTL（`5m`/`1h`）可配置，复用现有 `cacheRetention` 旋钮。
5. 图像 `detail`（`low`/`high`/`auto`）可配置，以质量换 token。

## 范围边界

- 范围内：目标 1–3（effort 阶梯、输出预算、媒体输入）在四个通道的实现；
  目标 4–5（缓存 TTL、图像 detail）仅限 DashScope 系通道；双语设计；单测；
  用户文档 effort 表；E2E 测试计划。
- 延后：CoT 摘要（`thinking_display` + `encrypted_content` 回传）与 ptc。
  两者均记录为后续工作。
- 产品/服务端依赖：Qwen 订阅网关须服务 `qwen4-max` 并接受 qwen4 effort/budget
  契约。把订阅默认模型（`QWEN_SUBSCRIPTION_MODEL`）从 `qwen3.8-max` 切换是产品
  决策，**本次不做**；本次仅保证服务端提供的 `qwen4-max` 可选且 effort 正确。

## 方案

### A. 模型身份与限额（`core`）

- `tokenLimits.ts`：在 `OUTPUT_PATTERNS` 的 `/^qwen/` 回退之前增
  `[/^qwen4-max/, 262_144]`。在 `defaultOutputCeiling` 为 `qwen4-max` 豁免
  `OUTPUT_TOKEN_CEILING`（仿 `CLAUDE_OPUS_EXTENDED`），使自动请求可携带完整的
  思考+回复预算；`clampOutputTokensToWindow` 仍按窗口余量约束每个请求。**收窄到
  `qwen4-max` 而非整个 `qwen4` 前缀**：合并上限是 qwen4-max 的契约，其他 `qwen4*`
  路由保持已发布的 32K 输出上限。输入对整个世代保持 1M。非思考上限导出为
  `QWEN4_NON_THINKING_OUTPUT_CAP`（131,072）。
- `pipeline.ts`：262,144 是**思考模式**上限；非思考输出上限为 131,072。由于
  关闭形状在 pipeline 里于 provider sizing `max_tokens` **之后**才定型，故在
  pipeline 中对思考禁用的 `qwen4-max` 请求把 `max_tokens` 夹到
  `QWEN4_NON_THINKING_OUTPUT_CAP`，避免短 prompt 的关思考请求超出非思考区间而
  400。门控按**最终线协议形状**（`reasoning_effort:'none'` 或
  `enable_thinking:false`）而非端点：DashScope 经 `reasoning_effort:'none'`
  关闭、Qwen 订阅经 `enable_thinking:false` 关闭，两者都须夹制。思考模式请求
  保持完整预算。
- `modalityDefaults.ts`：在 `MODALITY_PATTERNS` 的 `/^qwen/` 文本回退之前增
  `[/^qwen4-max/, { image:true, video:true }]`。
- `model-catalog.ts`：把 `PDF_CARVE_OUT_IDS` 扩展到 `qwen4-max`（该模型文档
  输入为 text/image/video，无 pdf），使未来 models.dev 的 pdf 标记不会启用
  不支持的路径。

### B. effort 档位与默认值（`core` preset + `cli` manifest）

- 在 `alibaba-standard.ts`、`alibaba-token-plan.ts`、`qwencloud-standard.ts`
  各增一个 `qwen4-max` `ModelSpec`：`contextWindowSize:1_000_000`、
  `capabilities.reasoning:{ thinking:true, efforts:['low','high','xhigh'],
defaultEffort:'high', disableField:'reasoning_effort' }`、
  `modalities:{ image:true, video:true }`。
- `model-configuration.ts`：增 `'qwen4-max'` manifest 条目（同档位/默认）。
  修改 `getModelConfiguration` 前缀回退，使仅 `qwen4-max*` id 解析 qwen4 档位；
  其他 `qwen4*` 路由与 `qwen-latest-series-invite-*` 仍用 `qwen3.8-max` 档位，
  既有模型保持已发布的 effort 控制。
- 超档位处理：声明能力路径通常**丢弃** `efforts` 之外的档位（既有契约）。
  qwen4-max 是例外：其服务端把持久化的 `medium`/`max` 映射到 `high`/`xhigh`，故
  `applyConfiguredReasoningEffort` 用 `clampReasoningEffort` 把它们夹到最近的
  声明档位，而非丢弃后落回服务端默认。其他声明模型（含其他 `qwen4*` 路由）保持
  丢弃行为。`none` 关闭已由 pipeline 送达。

### C. 订阅线协议形状（`core`）

- `pipeline.ts` 订阅分支：对 `qwen4-max` 线协议模型，把 effort 映射成 qwen4
  `thinking_budget` 档位（`low→4096`、`high→131072`、`xhigh→262144`），替代
  qwen3.8 表；保留 `enable_thinking` 开关。收窄到 `qwen4-max`，使其他 `qwen4*`
  与 qwen3.8 订阅模型保持已发布的预算表。

### D. 显式缓存 TTL（`core` + 设置，复用现有旋钮）

- 复用 `generationConfig.cacheRetention:'ephemeral'|'1h'`。在
  `dashscope.ts addCacheControlToContentArray` 中，当线协议模型为 `qwen4*` 且
  `cacheRetention==='1h'` 时，标记 `cache_control:{ type:'ephemeral',
ttl:'1h' }`；否则省略 `ttl`（5m 默认）。泛化该设置的文档，使其不限于
  Anthropic。
- `converter.ts` usage 解析已读 `cache_write_tokens`/`cached_tokens`；按 TTL
  的明细（`ephemeral_5m_input_tokens`/`ephemeral_1h_input_tokens`）为可选展示，
  本次非必需。

### E. 图像 `detail`（`core` + 设置，新旋钮）

- 增 `generationConfig.imageDetail:'low'|'high'|'auto'`（设置 schema、
  `ContentGeneratorConfig` 类型、`config.ts` 透传；默认 `undefined` = 服务端
  决定）。在 `converter.ts` 中，若设置则向每个 `image_url` part 注入 `detail`。
  qwen4-max 服务端默认 `high`；用户设 `low` 省 token。

## 设计决策与理由

- **复用 `cacheRetention` 而非新增 TTL 设置。** 该旋钮已存在、已端到端接通，
  其 `'ephemeral'|'1h'` 值恰好映射 qwen4 的 `5m`/`1h`。并行的 `cacheTtl` 设置
  会重复状态。
- **qwen4-max 契约收窄到 `qwen4-max`，而非整个 `qwen4` 前缀。** 原生档位、合并
  输出上限、非思考夹制、遗留档位夹取、订阅预算档位都是 §3.1 的 qwen4-max 契约；
  无厂商依据表明其他 `qwen4*` 路由共享。其他 `qwen4*` id 与 invite-series 预览
  保持 qwen3.8-max 档位与已发布的 32K 输出上限，既有模型行为不变。1M 输入窗口与
  tiered 线协议门仍按 `qwen4` 宽前缀（既有，#15987）；models.dev 一旦发布限额不同
  的 qwen4 条目，catalog 仍覆盖正则行。（缓存 TTL 门控也仍按 `qwen4` 宽前缀，因
  厂商文档把显式缓存归于整个「Qwen4 系列」，且仅在 opt-in 的 `'1h'` 设置下激活。）
- **为 qwen4-max 豁免 64K 输出上限。** `qwen3.8-max` 保持 64K `max_tokens`，因为
  其 `max_tokens` 不含 CoT。qwen4-max 的 `max_tokens` 含 CoT，故同样的 64K 会被
  思考消耗。豁免沿用现有 `CLAUDE_OPUS_EXTENDED` 先例；窗口夹制仍防止
  `prompt + max_tokens > window`。
- **声明 `efforts:['low','high','xhigh']`；仅 qwen4-max 夹取遗留选择。** 暴露原生
  三档让 UI 如实反映模型可区分的档位。声明 capability 的线协议路径仅对 qwen4-max
  经 `clampReasoningEffort` 把持久化的 `medium`/`max` 夹到声明阶梯
  （`medium→high`、`max→xhigh`）；其他无 profile 声明保持已发布的丢弃回服务端
  默认语义（遗留不重分级契约）。
- **订阅预算变更收窄到 qwen4-max。** 订阅网关的 qwen3.8 预算契约是已发布行为；
  仅 qwen4-max 采用新档位。
- **非思考预算夹制按最终线协议形状门控，而非端点。** 订阅网关
  （`api.qwen.ai`）不被识别为 DashScope，但其关闭路径同样经该 pipeline
  shaping 发出 `enable_thinking:false`；把夹制门控在 `isDashScope` 会让恰恰
  这条通道漏夹。通用 OpenAI-compatible 主机经 `chat_template_kwargs` 关闭，
  形状门控使夹制在其上不触发。

## 约束

- ESM、严格 TypeScript、无 `any`、core/cli kebab-case 文件、collocated
  `file.test.ts`、Prettier（单引号、2 空格、80 列）。
- cli 中的 core import 使用定义模块路径，而非包 barrel。
- 本次变更为 `feat` 型模型接入，非大规模 core refactor。

## 风险

- 订阅网关可能尚未服务 `qwen4-max`，或拒绝 qwen4 预算契约；客户端支持在该处
  必要但不充分。订阅非思考 131,072 夹制是依 §3.1 契约推断，未对 `api.qwen.ai`
  实测（无可用 key）。
- models.dev 的 `qwen4` catalog 条目会覆盖正则**输入窗口**行（输入 catalog
  优先）。**输出**则是 curated 行优先（`curatedOutputLimit(norm) ?? fromCatalog`），
  故 `/^qwen4-max/` 输出行存在后 catalog 无法覆盖它；catalog 仅为没有 curated
  行的 id 提供输出上限。
- 输出上限豁免实际上**不**与截断升级交互：qwen4-max 的初始预算（262,144，经
  窗口夹制）恒不小于升级后的上限（至多 64K），故 `shouldEscalateMaxOutputTokens`
  对它永不触发，升级路径不被演练。
- `imageDetail` 与 `cacheRetention` 仅在 DashScope 系通道携带；订阅 resolver 两者
  都不复制、订阅 provider 也不注入 `cache_control`，故二者在 Qwen 订阅上无效。
  用户文档已相应限定这两项控制的渠道。

## 验证计划

- `npm run build && npm run typecheck`。
- 对每个改动文件在所属包内 `npx vitest run <file>`（core 与 cli 各自目录）。
- 真实模型 E2E（`.qwen/e2e-tests/`）：在每个通道选择 `qwen4-max`，演练
  `/effort low|high|xhigh|none`、附加图像，并检查线协议 body（`reasoning_effort`
  档位与默认 `high`、`none` 关闭、`max_tokens` 总预算、`cache_control.ttl`、
  `image_url.detail`）与 `usage`。先对全局 `qwen` CLI dry-run 基线。

## 验收标准

1. `qwen4-max` 在四个通道出现且可选；effort 选择器显示 `low`/`high`/`xhigh`、
   默认 `high`，`none` 关闭思考。
2. 自动请求携带思考+回复 sized 的 `max_tokens`（非 32K/64K），并受上下文窗口
   约束；思考禁用时在 DashScope 与 Qwen 订阅上都夹到 131,072 非思考上限。
3. 图像与视频 part 对 `qwen4-max` 送达线协议。
4. `cacheRetention:'1h'` 在 qwen4 缓存断点标记 `ttl:'1h'`；默认省略 `ttl`。
   仅限 DashScope 系通道——订阅 provider 不注入 `cache_control` 断点。
5. `imageDetail:'low'` 向图像 part 注入 `detail:'low'`；默认不注入。仅限
   DashScope 系通道——订阅 resolver 不透传该设置。
6. qwen3.8-max 与其他 `qwen4*` 路由保持已发布的档位、默认值、输出上限、订阅
   预算表。
7. 仅 `qwen4-max` 在 workspace provider 控件中投影原生档位
   （`none/low/high/xhigh`、默认 `high`）；其他 `qwen4*` 路由、邀请制预览与
   stable 家族保持 qwen3.8-max 档位；订阅非思考 `qwen4-max` 请求发出
   `enable_thinking:false` 且 `max_tokens` 夹到 131,072。

## 待解问题 / 后续工作

- CoT 摘要：捕获 chat-completions `encrypted_content` 并在
  `thinking_display:'summarized'` 下原样回传（converter 目前不捕获）。
- ptc：加白的 programmatic tool calling。
- 订阅默认模型切换到 `qwen4-max`：待产品/服务端确认。
