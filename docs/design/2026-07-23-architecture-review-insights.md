# Qwen Code 设计思路、架构设计与工程思路

> 基于 PR #7530、#7534、#7531、#7551 等核心 PR 的 review 洞察，以及对代码库的深度分析。

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

## 五、架构演进方向

基于当前 PR 趋势的观察：

1. **缓存优化持续深化**：从 prompt tier 到 provider 能力缓存，系统性减少冗余计算
2. **Provider 自适应**：从配置驱动走向运行时学习，减少人工特判
3. **安全边界收紧**：git guard、env 隔离、权限分层持续完善
4. **多端一致性**：Web Shell、Desktop、Mobile 共享核心逻辑，UI 层隔离
5. **可观测性增强**：GenAI 遥测对齐 ARMS（PR #7536），结构化诊断日志
