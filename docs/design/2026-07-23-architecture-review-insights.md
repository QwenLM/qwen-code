# Qwen Code 设计思路、架构设计与工程思路

> 基于 33 个 PR 的 review 洞察（#7527–#7569）和代码库深度分析。
> 包含设计哲学、架构全景、工程模式，以及面向未来开发者的开发指南（第七节）。

## 一、设计哲学

### 1.1 最小可用原则（Simplicity First）

Qwen Code 的核心设计哲学是"解决问题的最少代码，不做投机性设计"。这体现在：

- **无预设抽象**：不为单次使用的代码创建抽象层。`prompt-fragments.ts` 仅 48 行，只做排序和渲染两件事。
- **无投机配置**：不添加未被请求的"灵活性"或"可配置性"。
- **无不可能场景的错误处理**：只在系统边界（用户输入、外部 API）做校验。

### 1.2 从错误中学习（Learn from Provider Errors）

PR #7534 展示了一个优雅的设计模式：当 provider 返回 400 要求 `enable_thinking: true` 时，pipeline 不是硬编码模型名特判，而是：

1. 检测错误消息中的能力约束信号
2. 在进程生命周期内记住该模型能力
3. 后续请求自动适配

这种"运行时能力发现"模式避免了配置膨胀，让系统自适应不同 provider 的约束。

### 1.3 显式优于隐式（Explicit over Implicit）

PR #7530 将 prompt 缓存边界从隐式变为显式：

- 每个 prompt 片段有明确的 `marker`（来源标识）、`role`（wire 角色）、`tier`（缓存层级）
- 渲染顺序由类型系统保证：`stable → context → volatile`
- 混合 role 渲染时 throw，防止 system/user 片段混装

## 二、架构设计

### 2.1 三层 Agentic Loop

```
GeminiClient (会话编排层)
  ├── Turn (单轮模型交互)
  │     └── GeminiChat (对话管理层)
  │           ├── 历史压缩 (micro/macro compaction)
  │           ├── 重试与模型降级
  │           └── JSONL 会话持久化
  ├── Hook 系统 (UserPromptSubmit / Stop)
  ├── Loop 检测 (安全阀)
  └── Memory 召回 (异步预取)
```

- **GeminiClient**（3353 行）：会话级编排器，`sendMessageStream()` 是 AsyncGenerator
- **Turn**（672 行）：单轮模型往返，发射类型化事件
- **GeminiChat**（4144 行）：对话管理，拥有 `history: Content[]`

### 2.2 Prompt 缓存分层架构

```
┌─────────────────────────────────────────┐
│  stable    │ 产品级指令（跨会话不变）      │  ← 前缀缓存命中区
├─────────────────────────────────────────┤
│  context   │ 工作区指令 + Git 快照        │  ← 会话内稳定
├─────────────────────────────────────────┤
│  volatile  │ 日期 / managed memory /     │  ← 频繁变化
│            │ append-system-prompt        │
└─────────────────────────────────────────┘
```

设计要点：
- 同层内保持插入顺序（stable sort），不引入意外重排
- 层间用 `\n\n---\n\n` 分隔，与原有行为兼容
- 日期从 workspace 上下文中拆出，避免每日使前缀缓存失效

### 2.3 Provider 抽象与 Pipeline 模式

```
ContentGenerationPipeline
  ├── Provider (请求构建)
  │     ├── DashScopeOpenAICompatibleProvider
  │     └── 通用 OpenAI-compatible
  ├── Converter (协议转换)
  │     ├── Gemini → OpenAI 请求
  │     └── OpenAI → Gemini 响应
  ├── executeWithRetry (统一重试)
  │     ├── 指数退避 (429/5xx/网络)
  │     ├── 模型降级链
  │     └── required-thinking 学习重试
  └── ErrorHandler (统一错误处理)
```

关键设计：
- 流式/非流式共享 `executeWithRetry` 路径
- `requiredThinkingModels` Set 实现进程级能力缓存
- `chat_template_kwargs`（非 DashScope）和 `enable_thinking`（DashScope）双格式支持

### 2.4 配置与记忆系统

```
Config
  ├── systemPromptContext (项目指令，context 层)
  ├── systemPromptVolatileMemory (managed memory，volatile 层)
  └── userMemory (向后兼容的合并视图)

Memory 层级：
  ├── 层级化项目指令 (QWEN.md / AGENTS.md，向上遍历)
  ├── Managed Auto-Memory (用户/项目/团队三层)
  └── appendToUserMemory → buildManagedPrompt 拆分
```

### 2.5 工具系统

- 工具通过 `ToolRegistry` 注册，支持 deferred tools（按需加载 schema）
- MCP（Model Context Protocol）集成外部工具服务器
- Skill 系统提供可复用的高级能力（如 `/review`、`/bugfix`）
- 权限系统（ApprovalMode）控制工具执行安全性

### 2.6 Web Shell 与 Shadow DOM 隔离

PR #7551 展示了组件隔离策略：
- 选择性 Shadow DOM 隔离，而非全局封装
- 支持 React 18/19 双版本（forwardRef 兼容）
- CSS 作用域限定 + 语义 token 系统
- Portal 组件通过 `useWebShellPortalRoot()` 保持主题/样式一致

## 三、工程思路

### 3.1 测试策略

| 层级 | 方式 | 示例 |
|------|------|------|
| 单元测试 | vitest，与源码同目录 | `prompt-fragments.test.ts` |
| 集成测试 | 构建 bundle 后运行 | `test:integration:cli:sandbox:none` |
| E2E 测试 | tmux 真实 TUI 交互 | `tmux-real-user-testing` skill |
| 协议边界 | 本地 HTTP/SSE mock provider | PR #7534 的 OpenAI SDK 测试 |

原则：
- 测试与源码同目录（collocated）
- 优先运行单个测试文件，避免全量套件
- CLI 测试中用 `vi.hoisted()` 处理 mock 提升

### 3.2 构建与质量门

```
npm run build      → TypeScript 编译 + 资源复制
npm run typecheck  → tsc --noEmit
npm run lint       → ESLint (no any, consistent imports, kebab-case)
npm run format     → Prettier (single quotes, 2-space, 80-char)
npm run preflight  → clean → install → format → lint → build → typecheck → test
```

### 3.3 代码规范

- **ESM only**：所有包 `"type": "module"`
- **Strict TypeScript**：`noImplicitAny`, `strictNullChecks`, `verbatimModuleSyntax`
- **命名**：`kebab-case.ts`（core/cli），`PascalCase.tsx`（React 组件）
- **注释**：默认无注释，只在 _why_ 不明显时添加
- **Conventional Commits**：`feat(core):`, `fix(cli):` 等

### 3.4 PR 工程文化

从 review 的 PR 中观察到的工程文化：

1. **设计文档先行**：非平凡变更附带 `docs/design/` 文档（如 PR #7530）
2. **双语 PR 描述**：英文主体 + 中文折叠说明
3. **Reviewer Test Plan**：描述验证行为和预期，而非脚本命令
4. **风险与范围声明**：明确主要风险、未验证项、破坏性变更
5. **测试平台矩阵**：标注 macOS/Windows/Linux 测试状态

### 3.5 安全设计

- **破坏性 Git 操作防护**：AUTO 模式下的 destructive-git guard（PR #7531）
- **权限分层**：ApprovalMode 控制工具执行
- **环境变量隔离**：hook 和工具发现子进程剥离 daemon 密钥（PR #7527）
- **不受信任内容标记**：MCP/skill 元数据保持 user-role reminder，不提升到 system role

## 四、关键设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| Prompt 缓存 | 显式三层 tier | 前缀缓存命中率可测试、可审计 |
| Provider 能力 | 运行时学习 | 避免模型名硬编码，自适应新 provider |
| Memory 拆分 | context/volatile 分离 | 日期变化不使项目指令缓存失效 |
| Shadow DOM | 选择性隔离 | 平衡样式隔离与主题一致性 |
| 工具加载 | Deferred tools | 减少初始 prompt token 占用 |
| 会话持久化 | JSONL 增量写入 | 崩溃恢复 + 低 I/O 开销 |
| 压缩策略 | 分层 (micro/macro) | 平衡上下文保留与 token 限制 |

## 五、从 PR Review 中提炼的工程模式

基于 9 个 PR（#7530, #7534, #7531, #7551, #7541, #7529, #7533, #7546, #7547）的 review，提炼出以下反复出现的工程模式：

### 5.1 语义精确性（Semantic Precision）

- **PR #7529**：cron 友好描述必须为真——"Every 25 minutes" 在 `*/25` 下是谎言（间隔不均）
- **PR #7533**：`write([])` 必须产生真正的空文件——1 字节 `\n` 让 `exists()` 和 `read()` 语义分裂
- **PR #7541**：`reasoning_effort: 'none'` 是显式禁用信号，不能与"未设置"混为一谈

**模式：** 每个修复都在追问"这个值/行为/描述的语义边界在哪里？"——不接受"差不多对"。

### 5.2 分支优先级与类型安全

- **PR #7546**：对象递归必须优先于关键字匹配——因为属性名可以合法地叫 `maximum`
- **PR #7547**：`const → enum` 转换必须与 `enum` 字符串化保持一致——同一语义路径不能有两种行为

**模式：** 当多个分支可以匹配同一输入时，优先级顺序就是语义契约。

### 5.3 安全边界的完备性

- **PR #7531**：`git clean -d -f` 和 `git checkout .` 是 `git clean -f` 和 `git checkout -- .` 的等价绕过路径
- **PR #7527**：hook 和工具发现子进程必须剥离 daemon 密钥

**模式：** 安全防护必须覆盖所有等价路径，而非仅覆盖"规范写法"。

### 5.4 运行时自适应优于静态配置

- **PR #7534**：从 provider 400 错误中学习 `thinkingMandatory`，而非硬编码模型名
- **PR #7530**：缓存层级由类型系统保证，而非依赖拼装顺序的隐式约定

**模式：** 能让系统自己发现的约束，不要写成配置；能让类型系统保证的不变量，不要写成注释。

### 5.5 不确定时保留（Conservative Cleanup）

- **PR #7539**：进程存活检测返回 EPERM（不确定）时保留文件，仅在 ESRCH（确认已死）时清理
- **PR #7535**：模型调用失败时分级降级（重试 → 熔断 → 回退），而非一刀切失败

**模式：** 清理/删除操作的不确定性代价远高于保留的成本。宁可多留一个孤儿文件，不可误删一个活跃资源。

### 5.6 依赖精简与零依赖替代

- **PR #7528**：用 `npm view` 替代 `update-notifier`（移除 ~40 个传递依赖）
- **PR #7545**：用 `.endsWith('.js')` 检测替代对版本管理器 wrapper 的硬编码适配

**模式：** 如果一个 10 行函数能替代一个 10 依赖的包，选择 10 行函数。

### 5.7 用户语言 vs 内部语言

- **PR #7550**：review 覆盖缺口从 "chunk 1, chunk 2" 改为 "the diff section covering src/a.ts"
- **PR #7529**：cron 显示从错误的 "Every 90 minutes" 改为原始表达式

**模式：** 面向用户的输出必须使用用户的概念模型，而非系统的内部簿记。

### 5.8 结构化数据替代文本反解析（Structure over Prose）

- **PR #7564**：`VerificationReport.gaps` 从 `string[]` 变为 `{subject, reason, subjectZh, reasonZh}`——消灭了 `compose-review` 中最后一处 `indexOf(' — ')` 边界反解析
- **PR #7564**：`Bi` 对（`{en, zh}`）让翻译分布式存在、渲染策略集中式决策

**模式：** 当消费者需要拆解生产者渲染的文本时，让生产者直接发射结构化数据。反解析是 bug 的温床——边界字符串会变、会歧义、会国际化。

### 5.9 单一事实来源（Single Source of Truth）

- **PR #7565**：测试不再手写 `INFRA_FAILURE_SIGNATURES` 副本，而是从工作流源提取——与 `NON_BLOCKING_CHECKS` 同一惯例
- **PR #7569**：英文子串被重置检测器 glob 消费——修改前必须 grep 所有消费方

**模式：** 如果一个值存在于生产配置中，测试应提取而非誊写。添加守卫断言在提取失败时响亮报错（而非空模式静默通过）。修改承重文本前，grep 所有程序化消费方。

### 5.10 只读 Fork 模式（Read-Only Fork for Side Queries）

- **PR #7567**：`/advisor` 用 `runForkedAgent` + `cacheSafeParams` 实现只读模型调用——共享 prompt cache 但 `NO_TOOLS` 禁止工具执行
- **PR #7567**：主会话历史不被修改，advisor 输出仅展示给用户

**模式：** 需要模型访问但不需要工具或会话修改时，用 forked side-query。缓存路径（`cacheSafeParams`）省 token，`NO_TOOLS` 保安全。并发控制由调用方负责。

### 5.11 渐进式披露（Progressive Disclosure）

- **PR #7589**：紧凑工具摘要从 "Read 3 files" 改为 "Read a.ts, b.ts, c.ts"（≤3 项内联，>3 项截断为 "a.ts, b.ts, ...and 2 more"）

**模式：** 数量小时显示具体项，数量大时回退到聚合。阈值（3）平衡信息密度与行宽。缺失描述时优雅降级到计数格式。

### 5.12 进程全局引导属于入口 Wrapper

- **PR #7594**：编译缓存传播在 `cli-entry.js`（入口 wrapper）中实现，而非 `spawnChannel`（共享基础设施）

**模式：** 进程全局引导行为（编译缓存、环境变量发布）属于入口 wrapper，不属于共享基础设施。入口 wrapper 拥有策略，子进程构造已经复制环境——不需要在 ACP 层做特殊处理。

### 5.13 验证解析目标的类型，而非仅验证存在性

- **PR #7591**：`fs.realpathSync` 成功解析 npm 路径，但目标可能是 bash shim 而非 JS 文件——用 `.endsWith('.js')` 验证类型

**模式：** 通过符号链接解析路径时，`realpathSync` 成功只说明文件存在，不说明文件类型正确。验证目标的类型（扩展名、内容格式）而非仅验证存在性。

### 5.14 环境变量覆盖链

- **PR #7579**：`parseBooleanEnvFlag(env) ?? setting ?? default` — 与 `QWEN_TELEMETRY_ENABLED` 完全一致的模式

**模式：** 添加新的环境变量覆盖时，复用 `parseBooleanEnvFlag()` 工具和三级优先级链（env > setting > default）。不要发明新的解析逻辑。

### 5.15 空操作的优雅降级

- **PR #7598**：ACP `conn.cancel()` 在 agent 空闲时返回 "Not currently generating"——视为成功而非报错

**模式：** 尝试取消/停止已完成的内容时，视为成功而非报错。用错误消息匹配（而非错误码）检测空操作状态——当协议没有专用错误码时，string match 是正确粒度。

### 5.16 AsyncLocalStorage 跨回调边界隔离

- **PR #7576**：teammate 的 agent/model 上下文通过回调泄漏到 leader——`runOutsideAgentContext()` 清除上下文

**模式：** 回调在异步上下文 A（teammate）中注册，在上下文 B（leader）中调用时，AsyncLocalStorage 上下文可能泄漏。修复：在回调注册处包裹上下文清除。当消费者是 React effect 时，需要第二条边界（React batching 可恢复外层 frame）。

### 5.17 Hook 生命周期完备性

- **PR #7592**：流式循环内三个 `return turn` 提前返回路径跳过了循环后的 Stop hook 代码——loop 检测未触发 StopFailure

**模式：** 当函数有多个提前返回路径（loop 检测、API 错误、正常完成）时，每条路径都必须触发适当的 hook 事件。模式：识别所有提前返回，在每个 `return` 前添加 hook 触发，使用 fire-and-forget（`.catch()`）防止 hook 失败影响主控制流。

### 5.18 单一流水线 + 可插拔后端

- **PR #7587**：触屏设备用 textarea 替代 CodeMirror，但复用同一提交流水线——`mobileText` 镜像到 `mobileTextRef`，`submitComposerText`/`getText`/`hasInput` 无需修改

**模式：** 添加设备特定 UI 变体时，复用提交/状态流水线，仅切换输入后端。将替代输入的状态镜像到流水线读取的同一 ref 结构，使所有操作无需修改。避免并行路径的状态漂移风险。

### 5.19 关注点分离：设备检测 vs 行为门控

- **PR #7587**：`useIsTouchComposer()`（冻结于 mount，含 URL 覆盖）选择编辑器后端；`isCoarsePointerDevice()`（非响应式，忽略覆盖）控制 focus 行为

**模式：** 设备检测有两种用途——选择 UI 后端和控制设备特定行为（如 focus）。分离为两个独立函数：一个响应配置覆盖（用于 UI 选择），一个忽略覆盖（用于物理行为门控）。即使强制使用某后端，物理行为仍按设备类型执行。

### 5.20 两级所有权验证（Workspace 限定变更）

- **PR #7577**：channel lifecycle 限定到 workspace runtime——`assertRequiredOwner`（目标解析层）+ `assertCommittedOwner`（已提交状态层）

**模式：** 当进程全局服务跨多 workspace 管理资源时，在两个层级验证所有权：(1) 目标解析——资源是否解析到唯一 workspace？(2) 已提交状态——资源是否当前被唯一 worker 拥有？用专用 lane 序列化变更，与读取分离。防止跨 workspace 干扰。

### 5.21 执行证据 vs. 完成权威

- **PR #7580**：Todo 计划节点拥有完成状态；Agent 执行是证据而非完成触发器——失败/取消的执行不会错误完成 Todo

**模式：** 将"应做什么"（计划/Todo）与"正在做什么"（代理执行）分离。计划节点拥有完成权威；执行提供证据。防止失败的执行错误完成计划项，允许独立重试而不解锁依赖项。

### 5.22 长时间 CI 作业的持久入队

- **PR #7584**：GitHub Release 触发 → SQLite 入队 → GitHub job 结束 → systemd worker 异步执行——不占用 runner

**模式：** CI 触发多分钟/多小时的作业时不占用 runner。验证 + 持久入队（SQLite），返回"已接受"而非"已完成"，让独立 worker 负责执行、心跳、重试和完成。将触发可靠性与执行可靠性分离。

### 5.23 管理员拥有的安全选择器

- **PR #7586**：`context_search` 工具的 tenant/user/repository/namespace 由管理员配置固定——模型只能选 `query` 和 `limit`

**模式：** 工具暴露的授权边界参数（tenant、user、namespace）由管理员配置固定，不让模型选择。将工具参数面变为非授权边界，保持信任模型简单。模型可选择的参数不能是安全边界。

### 5.24 解析器必须精确匹配 shell 语义

- **PR #7526**：`splitCommands` 在单引号内将反斜杠视为转义——`'a\'; rm -rf /tmp/x` 被解析为单个 `echo`，隐藏了 `rm`，绕过权限检查

**模式：** Shell 解析规则在引号类型间不同——单引号内无转义（字面），双引号内允许转义。统一处理两类引号的解析器会创建可利用的间隙——解析器看到的与 shell 执行的不一致。安全关键解析器必须针对 shell 真值测试，而非"合理"假设。

## 六、架构演进方向

基于当前 PR 趋势的观察：

1. **缓存优化持续深化**：从 prompt tier 到 provider 能力缓存，系统性减少冗余计算
2. **Provider 自适应**：从配置驱动走向运行时学习，减少人工特判
3. **安全边界收紧**：git guard、env 隔离、权限分层持续完善
4. **多端一致性**：Web Shell、Desktop、Mobile 共享核心逻辑，UI 层隔离
5. **可观测性增强**：GenAI 遥测对齐 ARMS（PR #7536），结构化诊断日志

## 七、开发指南：如何在这个项目中正确实现功能

> 基于 33 个 PR 的 review 和代码库深度分析，面向未来开发者。
> 每一节回答"如何正确做 X"，附带代码路径和关键约束。

### 7.1 如何添加一个新的 CLI Slash Command

**参考实现：** `/advisor`（PR #7567）、`/btw`（`packages/cli/src/ui/commands/btwCommand.ts`）

**步骤：**

1. **创建命令文件** `packages/cli/src/ui/commands/<name>-command.ts`（kebab-case）

```typescript
import type { CommandContext, SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';

export const myCommand: SlashCommand = {
  name: 'mycommand',
  get description() { return t('What this command does'); },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  action: async (context: CommandContext, args: string): Promise<void | SlashCommandActionReturn> => {
    // 1. 校验输入  2. 获取 config  3. 执行逻辑  4. 返回结果
  },
};
```

2. **注册到 BuiltinCommandLoader**（`packages/cli/src/services/BuiltinCommandLoader.ts`）：
   - 添加 import，在 `allDefinitions` 数组中按字母序插入
   - 条件加载：`this.config?.isXxxEnabled() ? myCommand : null`

3. **添加设置（如需要）**：
   - `packages/cli/src/config/settingsSchema.ts`：`SETTINGS_SCHEMA` 中添加定义
   - `packages/vscode-ide-companion/schemas/settings.schema.json`：同步 JSON Schema
   - 读取：`context.services.settings.merged.<name>`

4. **编写测试** `<name>-command.test.ts`：
   - `createMockCommandContext()`（`packages/cli/src/test-utils/mockCommandContext.ts`）
   - `vi.hoisted()` 提升 mock（mock factory 在模块加载时执行）
   - 覆盖：元数据、输入校验、成功/错误/abort 路径、各执行模式

**关键约束：**

- `action` 返回类型决定 UI 行为：`message` / `dialog` / `submit_prompt` / `void`（自行管理）
- 交互式长操作用 `ui.setPendingItem()` 显示进度，`finally` 中清除
- `context.abortSignal` 支持 ESC 取消
- 所有用户可见文本用 `t()` 包裹（i18n）

### 7.2 如何使用 Forked Side-Query（只读模型调用）

**参考实现：** `/btw`、`/advisor`（`packages/core/src/utils/forkedAgent.ts`）

**场景：** 调用模型但不影响主会话历史、不允许工具执行。

```typescript
import { runForkedAgent, buildBtwCacheSafeParams } from '@qwen-code/qwen-code-core';

const cacheSafeParams = buildBtwCacheSafeParams(config);
const result = await runForkedAgent({
  config,
  userMessage: 'your prompt',
  cacheSafeParams,     // 共享主会话 prompt cache
  abortSignal,
  // model: 'other-model',  // 可选覆盖
  // jsonSchema: {...},      // 可选结构化输出
});
```

| 路径 | 参数 | 特点 | 用途 |
|------|------|------|------|
| Cache path | `cacheSafeParams` | 单轮、无工具、共享缓存 | /btw, /advisor |
| Agent path | `taskPrompt` | 多轮、完整工具、隔离会话 | memory extract, dream |

**关键约束：**
- Cache path 默认 `NO_TOOLS`——模型不能调用工具
- 主会话历史不被修改（fork 只读）
- `buildBtwCacheSafeParams` 返回 `null` = 无对话上下文
- 并发控制由调用方负责

### 7.3 如何添加新的 Prompt 片段

**参考实现：** PR #7530（`packages/core/src/core/prompt-fragments.ts`，48 行）

**三层缓存模型：** `stable`（跨会话不变）→ `context`（会话内稳定）→ `volatile`（频繁变化）

**步骤：**
1. 确定缓存层级（内容多久变一次？）
2. 在 `getAdditionalSystemPromptFragments()`（`client.ts`）中构建 `{ marker, role, tier, content }`
3. 自动按 tier 排序，同层保持插入顺序，层间 `\n\n---\n\n` 分隔

**关键约束：**
- 不要手动拼接 system prompt——用 fragment 系统
- 每日变化内容必须放 volatile 层（否则前缀缓存每日失效）
- `renderPromptFragments()` 混合 role 时 throw

### 7.4 如何添加 Provider 能力适配

**参考实现：** PR #7534（`pipeline.ts`）

**模式：** 运行时学习优于静态配置

```typescript
// 1. 检测错误中的能力约束信号（精确正则）
// 2. 进程级 Set 缓存已学习的能力
// 3. 统一查询入口合并配置 + 运行时学习
// 4. 重试时 executeAttempt() 闭包重建请求
```

**关键约束：**
- 不硬编码模型名——从错误消息学习
- 能力缓存进程级、不持久化——重启后重新学习
- 流式/非流式共享 `executeWithRetry` 路径

### 7.5 如何添加新的工具（Tool）

**参考实现：** `packages/core/src/tools/tool-registry.ts`

**注册流程：** `registerTool()` → 检查 disabledTools → 检查名称冲突 → 存入 Map → 声明排序

**Deferred Tools：** `shouldDefer: true` → 初始不出现在 declarations → `tool_search` 按需加载

**MCP 工具：** `mcp__<server>__<tool>` 命名，`McpTransportPool` 多会话共享

**关键约束：**
- 声明顺序必须稳定（`compareToolsByDeclarationName`）
- `disabledTools` 是全局 chokepoint
- schema 变更影响 prompt cache

### 7.6 如何编写测试

```bash
# 单个文件（始终优先）
cd packages/core && npx vitest run src/path/to/file.test.ts
cd packages/cli && npx vitest run src/path/to/file.test.ts
```

**CLI 测试关键模式：**
- `vi.hoisted()` 提升 mock（必需品，不是可选项）
- `createMockCommandContext()` 构造命令上下文
- 断言钉住具体值（包括中文字符串）

**工作流测试 single-source 模式（PR #7565）：**
```javascript
const value = workflow.match(/MY_VAR: '([^']*)'/)?.[1];
expect(value).toContain('expected-substring'); // 守卫：提取失败响亮报错
```

### 7.7 如何实现双语支持

**参考实现：** PR #7564（折叠块）、PR #7569（内联 `·`）

| 模式 | 适用场景 | 实现 |
|------|----------|------|
| `<details>` 折叠块 | 长文本 | 英文在前，中文折叠 |
| 内联 `·` 分隔 | 短文本 | `English · 中文` |

**关键约束：**
- 英文半边可能承重（被检测器 glob）——修改前 grep 消费方
- 用结构化数据（`subjectZh`/`reasonZh`），不从渲染文本反解析
- 中英文串并排维护，空翻译不发布空折叠块

### 7.8 如何添加新的设置项

1. `settingsSchema.ts`：`SETTINGS_SCHEMA` 中添加 `{ type, label, category, requiresRestart, default, description, showInDialog }`
2. `settings.schema.json`：同步 JSON Schema
3. 读取：`context.services.settings.merged.<name>`

### 7.9 ContentGenerationPipeline 请求生命周期

```
GenerateContentParameters (Gemini 格式)
  → Provider.buildRequest() → OpenAI 格式
  → executeWithRetry()（429/5xx 退避、能力学习重试、模型降级）
  → Converter（Gemini ↔ OpenAI 双向转换）
  → ErrorHandler（统一错误分类）
```

- 流式/非流式共享 `executeWithErrorHandling()`
- 每请求创建子 AbortController（防 OpenAI SDK listener 泄漏）
- 不要在 pipeline 外做重试

### 7.10 三层 Agentic Loop 功能定位

| 功能类型 | 放在哪一层 | 示例 |
|----------|-----------|------|
| 会话级编排（跨轮次） | GeminiClient (`client.ts`) | Hook、Loop 检测、Memory |
| 单轮交互逻辑 | Turn (`turn.ts`) | 事件发射、工具调用分发 |
| 对话历史管理 | GeminiChat (`geminiChat.ts`) | 压缩、持久化、重试 |
| 协议转换 | Pipeline/Converter | Gemini ↔ OpenAI |

### 7.11 项目包结构与依赖规则

```
packages/
├── core/     → 引擎（Agentic Loop、工具、Provider、配置）
├── cli/      → TUI（Ink/React、命令、设置）
├── web-shell/→ Web 嵌入（Shadow DOM 隔离）
├── desktop/  → Electron 桌面应用
├── acp-bridge/→ ACP 协议桥接
├── channels/ → 消息通道（DingTalk、Feishu 等）
└── sdk-*/    → TypeScript/Python/Java SDK
```

- `cli` → `core` 单向依赖，用包名 `@qwen-code/qwen-code-core`
- 不允许包间相对 import

### 7.12 常见开发陷阱

| 陷阱 | 正确做法 |
|------|----------|
| 从项目根运行 vitest | `cd packages/<pkg> && npx vitest run <file>` |
| CLI 测试中直接引用外部变量 | `vi.hoisted()` 提升 |
| 手动拼接 system prompt | PromptFragment 系统 |
| 硬编码模型名特判 | 运行时从错误中学习 |
| pipeline 外做重试 | `executeWithRetry` |
| 修改英文文案不检查消费方 | grep 检测器/测试中的 glob |
| 假设库可用 | 检查 package.json + 现有 import |
| 添加注释解释"做了什么" | 只在"为什么"不明显时添加 |
