# Qwen Code Hooks 设计文档

## 目录

1. [概述](#概述)
2. [当前实现分析](#当前实现分析)
3. [Claude Code Hooks 参考](#claude-code-hooks-参考)
4. [差异对比与缺失能力](#差异对比与缺失能力)
5. [补齐能力设计方案](#补齐能力设计方案)
6. [实施优先级与路线图](#实施优先级与路线图)

---

## 概述

Hooks 是 AI Code Agent 中用户定义的命令，可以在应用生命周期的各个点执行。它们提供了强大的扩展机制，允许用户：

- 在工具执行前后进行验证和拦截
- 处理用户提交的 prompt
- 监控会话生命周期事件
- 与 MCP 服务器交互
- 实现自定义权限控制逻辑

本文档分析 Qwen Code 当前 hooks 实现与 Claude Code hooks 的差异，并提出补齐能力的设计方案。

---

## 当前实现分析

### 架构概览

Qwen Code hooks 系统采用模块化架构，由以下核心组件构成：

```
┌─────────────────────────────────────────────────────────────┐
│                     HookSystem (入口)                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ HookRegistry│  │ HookPlanner │  │ HookRunner  │          │
│  │ (注册管理)  │→ │ (计划创建)  │→ │ (执行引擎)  │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│         ↓               ↓               ↓                   │
│  ┌─────────────────────────────────────────────┐            │
│  │           HookEventHandler                   │            │
│  │           (事件触发协调)                      │            │
│  └─────────────────────────────────────────────┘            │
│                        ↓                                    │
│  ┌─────────────────────────────────────────────┐            │
│  │           HookAggregator                     │            │
│  │           (结果聚合)                          │            │
│  └─────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

### 核心模块

| 模块             | 文件                  | 功能                                 |
| ---------------- | --------------------- | ------------------------------------ |
| HookSystem       | `hookSystem.ts`       | 主入口，协调所有 hook 相关功能       |
| HookRegistry     | `hookRegistry.ts`     | 加载和验证 hook 定义，管理 hook 注册 |
| HookPlanner      | `hookPlanner.ts`      | 选择匹配的 hooks，创建执行计划       |
| HookRunner       | `hookRunner.ts`       | 执行单个 hook 命令                   |
| HookAggregator   | `hookAggregator.ts`   | 合并多个 hook 输出结果               |
| HookEventHandler | `hookEventHandler.ts` | 触发各类 hook 事件                   |

### 已支持的事件类型

```typescript
enum HookEventName {
  PreToolUse = 'PreToolUse', // 工具执行前
  PostToolUse = 'PostToolUse', // 工具执行后
  PostToolUseFailure = 'PostToolUseFailure', // 工具执行失败后
  Notification = 'Notification', // 通知发送时
  UserPromptSubmit = 'UserPromptSubmit', // 用户提交 prompt 时
  SessionStart = 'SessionStart', // 会话开始时
  Stop = 'Stop', // 响应结束前
  SubagentStart = 'SubagentStart', // 子代理启动时
  SubagentStop = 'SubagentStop', // 子代理结束时
  PreCompact = 'PreCompact', // 对话压缩前
  SessionEnd = 'SessionEnd', // 会话结束时
  PermissionRequest = 'PermissionRequest', // 权限请求时
}
```

### 已支持的 Hook 类型

当前仅支持 **CommandHook**：

```typescript
interface CommandHookConfig {
  type: 'command';
  command: string; // Shell 命令
  name?: string; // Hook 名称
  description?: string; // 描述
  timeout?: number; // 超时时间（默认 60s）
  source?: HooksConfigSource;
  env?: Record<string, string>;
}
```

### Matcher 支持

| 事件类型                                                       | Matcher 目标                          | 匹配方式   |
| -------------------------------------------------------------- | ------------------------------------- | ---------- |
| PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest | 工具名                                | 正则表达式 |
| SubagentStart, SubagentStop                                    | Agent 类型                            | 正则表达式 |
| SessionStart                                                   | Source (startup/resume/clear/compact) | 正则表达式 |
| SessionEnd                                                     | Reason (clear/logout/...)             | 正则表达式 |
| Notification                                                   | Notification Type                     | 精确匹配   |
| PreCompact                                                     | Trigger (manual/auto)                 | 精确匹配   |
| UserPromptSubmit, Stop                                         | 无                                    | N/A        |

### 执行模式

- **并行执行**（默认）：多个 hooks 同时执行
- **顺序执行**：通过 `sequential: true` 配置，hooks 按顺序执行，可修改后续 hook 的输入

### Exit Code 处理

| Exit Code | 含义       | 行为                         |
| --------- | ---------- | ---------------------------- |
| 0         | 成功       | stdout/stderr 不显示         |
| 2         | 阻塞错误   | 显示 stderr 给模型并阻止操作 |
| 其他      | 非阻塞错误 | 显示 stderr 给用户但继续执行 |

---

## Claude Code Hooks 参考

### 事件类型对比

Claude Code 支持的事件类型（共 26 个）：

```typescript
const HOOK_EVENTS = [
  'PreToolUse', // ✓ Qwen 已有
  'PostToolUse', // ✓ Qwen 已有
  'PostToolUseFailure', // ✓ Qwen 已有
  'Notification', // ✓ Qwen 已有
  'UserPromptSubmit', // ✓ Qwen 已有
  'SessionStart', // ✓ Qwen 已有
  'Stop', // ✓ Qwen 已有
  'SubagentStart', // ✓ Qwen 已有
  'SubagentStop', // ✓ Qwen 已有
  'PreCompact', // ✓ Qwen 已有
  'SessionEnd', // ✓ Qwen 已有
  'PermissionRequest', // ✓ Qwen 已有

  // ✗ Qwen 缺失
  'StopFailure', // API 错误导致 turn 结束时
  'PermissionDenied', // 自动模式分类器拒绝工具后
  'Setup', // 仓库设置时
  'TeammateIdle', // 队友空闲时
  'TaskCreated', // 任务创建时
  'TaskCompleted', // 任务完成时
  'Elicitation', // MCP 请求用户输入时
  'ElicitationResult', // 用户响应 MCP elicitation 后
  'ConfigChange', // 配置文件变更时
  'WorktreeCreate', // 创建 worktree 时
  'WorktreeRemove', // 移除 worktree 时
  'InstructionsLoaded', // 加载指令文件时
  'CwdChanged', // 工作目录变更时
  'FileChanged', // 监视文件变更时
  'PostCompact', // 对话压缩后
];
```

### Hook 命令类型对比

Claude Code 支持的 Hook 类型（共 6 种）：

| 类型                | 描述                 | Qwen 支持 |
| ------------------- | -------------------- | --------- |
| **BashCommandHook** | Shell 命令执行       | ✓ 已有    |
| **PromptHook**      | LLM 评估（单轮）     | ✗ 缺失    |
| **AgentHook**       | 多轮 LLM 验证        | ✗ 缺失    |
| **HttpHook**        | HTTP POST 请求       | ✗ 缺失    |
| **HookCallback**    | 内部 TypeScript 回调 | ✗ 缺失    |
| **FunctionHook**    | Session 专用回调     | ✗ 缺失    |

### Claude Code 特有功能

#### 1. PromptHook（LLM 评估）

```typescript
type PromptHook = {
  type: 'prompt';
  prompt: string; // LLM 评估的 prompt，使用 $ARGUMENTS 占位符
  if?: string; // 条件过滤（权限规则语法）
  timeout?: number;
  model?: string; // 使用的模型（默认 small fast model）
  statusMessage?: string;
  once?: boolean; // 执行一次后移除
};
```

使用 LLM 来评估 hook 条件，返回 `{ ok: true }` 或 `{ ok: false, reason: "..." }`。

#### 2. AgentHook（多轮 LLM）

```typescript
type AgentHook = {
  type: 'agent';
  prompt: string; // 验证 prompt
  if?: string;
  timeout?: number; // 默认 60s
  model?: string;
  statusMessage?: string;
  once?: boolean;
};
```

多轮 LLM 验证，最多 50 转换，通过 StructuredOutputTool 获取结果。

#### 3. HttpHook

```typescript
type HttpHook = {
  type: 'http';
  url: string; // POST 目标 URL
  if?: string;
  timeout?: number;
  headers?: Record<string, string>; // 支持 $VAR_NAME 环境变量插值
  allowedEnvVars?: string[]; // 允许插值的环境变量列表
  statusMessage?: string;
  once?: boolean;
};
```

HTTP POST 请求，包含 URL 白名单检查、SSRF 防护、Sandbox 代理支持。

#### 4. 异步 Hook

```typescript
type BashCommandHook = {
  // ...
  async?: boolean; // 后台执行，不阻塞
  asyncRewake?: boolean; // 后台执行，exit code 2 时唤醒模型
};
```

- `async: true` - 后台执行，不阻塞主流程
- `asyncRewake: true` - 后台执行，当 exit code 2 时唤醒模型继续对话

#### 5. Session Hooks

```typescript
// 添加 function hook 到 session
function addFunctionHook(
  setAppState: ...,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  callback: FunctionHookCallback,
  errorMessage: string,
  options?: { timeout?: number, id?: string },
): string

// 添加命令/prompt hook 到 session
function addSessionHook(
  setAppState: ...,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand,
  ...
): void
```

Session Hooks 特点：

- 临时性，仅在内存中存在
- 会话结束时清除
- 支持 TypeScript 回调函数
- 可通过 skill frontmatter 注册

#### 6. Hook 事件系统

```typescript
type HookStartedEvent = {
  type: 'started';
  hookId: string;
  hookName: string;
  hookEvent: string;
};

type HookProgressEvent = {
  type: 'progress';
  hookId: string;
  stdout: string;
  stderr: string;
  output: string;
};

type HookResponseEvent = {
  type: 'response';
  hookId: string;
  outcome: 'success' | 'error' | 'cancelled';
  exitCode?: number;
};

// 广播函数
function emitHookStarted(hookId, hookName, hookEvent): void;
function emitHookProgress(data): void;
function emitHookResponse(data): void;
function registerHookEventHandler(handler): void;
```

#### 7. 其他特性

| 特性                   | 描述                  | Qwen 支持 |
| ---------------------- | --------------------- | --------- |
| `if` 条件过滤          | 权限规则语法条件      | ✗ 缺失    |
| `once` 标志            | 执行一次后移除        | ✗ 缺失    |
| `statusMessage`        | 自定义状态消息        | ✗ 缺失    |
| `shell` 选择           | bash 或 powershell    | ✗ 缺失    |
| `allowedEnvVars`       | 环境变量插值白名单    | ✗ 缺失    |
| URL 白名单             | HTTP hook URL 检查    | ✗ 缺失    |
| SSRF 防护              | 私有 IP 阻止          | ✗ 缺失    |
| `watchPaths`           | 文件监视路径          | ✗ 缺失    |
| `updatedMCPToolOutput` | MCP 工具输出更新      | ✗ 缺失    |
| `retry`                | PermissionDenied 重试 | ✗ 缺失    |

---

## 差异对比与缺失能力

### 缺失能力汇总

#### 高优先级缺失

| 能力                 | 影响                        | 复杂度 |
| -------------------- | --------------------------- | ------ |
| **PromptHook**       | 无法使用 LLM 评估 hook 条件 | 高     |
| **HttpHook**         | 无法与外部服务集成          | 中     |
| **异步 Hook**        | 长时间 hook 阻塞主流程      | 中     |
| **Session Hooks**    | 无法动态添加临时 hooks      | 中     |
| **StopFailure 事件** | 无法处理 API 错误场景       | 低     |
| **PostCompact 事件** | 无法在压缩后执行操作        | 低     |

#### 中优先级缺失

| 能力              | 影响                         | 复杂度 |
| ----------------- | ---------------------------- | ------ |
| **AgentHook**     | 无法进行多轮 LLM 验证        | 高     |
| **HookCallback**  | 无法使用内部 TypeScript 回调 | 中     |
| **Hook 事件系统** | 无法实时监控 hook 执行       | 中     |
| **if 条件过滤**   | 无法使用权限规则语法         | 中     |
| **once 标志**     | 无法实现一次性 hook          | 低     |
| **statusMessage** | 无法自定义状态消息           | 低     |

#### 低优先级缺失

| 能力                        | 影响                     | 复杂度            |
| --------------------------- | ------------------------ | ----------------- |
| **Teammate/Task 事件**      | 团队协作功能缺失         | 高（需整体功能）  |
| **Elicitation 事件**        | MCP elicitation 功能缺失 | 高（需 MCP 支持） |
| **Worktree 事件**           | Worktree 管理功能缺失    | 中                |
| **CwdChanged/FileChanged**  | 文件监视功能缺失         | 中                |
| **ConfigChange 事件**       | 配置变更监控缺失         | 低                |
| **InstructionsLoaded 事件** | 指令加载监控缺失         | 低                |
| **shell 选择**              | Windows PowerShell 支持  | 低                |
| **allowedEnvVars**          | 环境变量安全控制         | 低                |

### 功能对比矩阵

| 功能           | Claude Code | Qwen Code | 优先级 |
| -------------- | ----------- | --------- | ------ |
| Command Hook   | ✓           | ✓         | -      |
| Prompt Hook    | ✓           | ✗         | P0     |
| Agent Hook     | ✓           | ✗         | P1     |
| Http Hook      | ✓           | ✗         | P0     |
| Function Hook  | ✓           | ✗         | P1     |
| Callback Hook  | ✓           | ✗         | P1     |
| 异步执行       | ✓           | ✗         | P0     |
| asyncRewake    | ✓           | ✗         | P1     |
| Session Hooks  | ✓           | ✗         | P0     |
| Hook 事件广播  | ✓           | ✗         | P1     |
| if 条件过滤    | ✓           | ✗         | P1     |
| once 标志      | ✓           | ✗         | P2     |
| statusMessage  | ✓           | ✗         | P2     |
| Matcher 支持   | ✓           | ✓         | -      |
| 并行/顺序执行  | ✓           | ✓         | -      |
| Timeout        | ✓           | ✓         | -      |
| Exit Code 处理 | ✓           | ✓         | -      |
| 结果聚合       | ✓           | ✓         | -      |
| 26 种事件      | ✓           | 12 种     | P0-P2  |

---

## 补齐能力设计方案

### Phase 1: 核心 Hook 类型扩展

#### 1.1 PromptHook 实现

**目标**：使用 LLM 评估 hook 条件

**设计**：

```typescript
// packages/core/src/hooks/types.ts

interface PromptHookConfig {
  type: 'prompt';
  prompt: string; // LLM 评估的 prompt
  if?: string; // 条件过滤
  timeout?: number; // 默认 30s
  model?: string; // 可选指定模型
  name?: string;
  description?: string;
  once?: boolean;
  statusMessage?: string;
}

// packages/core/src/hooks/execPromptHook.ts

class PromptHookRunner {
  async execute(
    hook: PromptHookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    // 1. 替换 $ARGUMENTS 占位符
    const prompt = this.replacePlaceholders(hook.prompt, input);

    // 2. 使用 small fast model 查询
    const response = await this.llmClient.query(prompt, {
      model: hook.model || 'qwen-turbo',
      timeout: hook.timeout || 30000,
      signal,
    });

    // 3. 解析 JSON 响应
    const result = this.parseResponse(response);
    // { ok: true } 或 { ok: false, reason: "..." }

    return {
      hookConfig: hook,
      eventName,
      success: result.ok,
      output: {
        decision: result.ok ? 'allow' : 'deny',
        reason: result.reason,
      },
    };
  }
}
```

**集成点**：

- 在 `HookRunner` 中添加 `executePromptHook` 方法
- 在 `HookSystem` 中注册 PromptHook 类型

#### 1.2 HttpHook 实现

**目标**：支持 HTTP POST 请求作为 hook

**设计**：

```typescript
// packages/core/src/hooks/types.ts

interface HttpHookConfig {
  type: 'http';
  url: string;
  if?: string;
  timeout?: number; // 默认 30s
  headers?: Record<string, string>;
  allowedEnvVars?: string[]; // 环境变量插值白名单
  name?: string;
  description?: string;
  once?: boolean;
  statusMessage?: string;
}

// packages/core/src/hooks/execHttpHook.ts

class HttpHookRunner {
  async execute(
    hook: HttpHookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    // 1. URL 白名单检查
    if (!this.isUrlAllowed(hook.url)) {
      return this.createErrorResult('URL not in allowed list');
    }

    // 2. 环境变量插值（仅 allowedEnvVars 中的）
    const headers = this.interpolateHeaders(hook.headers, hook.allowedEnvVars);

    // 3. SSRF 防护检查
    if (this.isPrivateIp(hook.url)) {
      return this.createErrorResult('Private IP blocked');
    }

    // 4. 发送 POST 请求
    const response = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal,
      timeout: hook.timeout || 30000,
    });

    // 5. 解析响应
    const result = await response.json();

    return {
      hookConfig: hook,
      eventName,
      success: response.ok,
      output: result,
    };
  }
}
```

**安全考虑**：

- URL 白名单配置：`allowedHttpHookUrls` in settings
- SSRF 防护：阻止私有 IP 地址（10.x, 172.16-31.x, 192.168.x, localhost）
- 环境变量安全：仅允许 `allowedEnvVars` 列表中的变量插值

#### 1.3 异步 Hook 支持

**目标**：支持后台执行，不阻塞主流程

**设计**：

```typescript
// packages/core/src/hooks/types.ts

interface CommandHookConfig {
  type: 'command';
  command: string;
  // ... 现有字段
  async?: boolean; // 后台执行，不阻塞
  asyncRewake?: boolean; // 后台执行，exit code 2 时唤醒模型
}

// packages/core/src/hooks/asyncHookRegistry.ts

interface PendingAsyncHook {
  processId: string;
  hookId: string;
  hookName: string;
  hookEvent: HookEventName;
  startTime: number;
  timeout: number;
  command: string;
  shellProcess?: ChildProcess;
}

class AsyncHookRegistry {
  private pendingHooks: Map<string, PendingAsyncHook> = new Map();

  register(hook: PendingAsyncHook): void {
    this.pendingHooks.set(hook.processId, hook);
  }

  async checkResponses(): Promise<AsyncHookResponse[]> {
    // 检查所有 pending hooks 的状态
    const responses: AsyncHookResponse[] = [];

    for (const [id, hook] of this.pendingHooks) {
      if (hook.shellProcess?.exitCode !== undefined) {
        responses.push({
          processId: id,
          exitCode: hook.shellProcess.exitCode,
          stdout: hook.stdout,
          stderr: hook.stderr,
        });

        // 如果 exit code 2 且 asyncRewake=true，触发模型唤醒
        if (hook.asyncRewake && hook.shellProcess.exitCode === 2) {
          this.triggerModelRewake(hook);
        }

        this.pendingHooks.delete(id);
      }
    }

    return responses;
  }
}
```

**集成点**：

- 在 `HookRunner.executeHook` 中检测 `async` 标志
- 异步 hook 注册到 `AsyncHookRegistry`
- 在主循环中定期调用 `checkResponses()`

### Phase 2: Session Hooks 与事件系统

#### 2.1 Session Hooks 实现

**目标**：支持动态添加临时 hooks

**设计**：

```typescript
// packages/core/src/hooks/sessionHooks.ts

interface FunctionHookConfig {
  type: 'function';
  id?: string;
  timeout?: number;
  callback: (input: HookInput, signal: AbortSignal) => Promise<HookOutput>;
  errorMessage: string;
  statusMessage?: string;
}

interface SessionHookStore {
  hooks: Map<HookEventName, SessionHookMatcher[]>;
  functionHooks: Map<HookEventName, FunctionHookMatcher[]>;
}

class SessionHooksManager {
  private sessionStores: Map<string, SessionHookStore> = new Map();

  addSessionHook(
    sessionId: string,
    event: HookEventName,
    matcher: string,
    hook: HookConfig,
  ): void {
    const store = this.getOrCreateStore(sessionId);
    const matchers = store.hooks.get(event) || [];
    matchers.push({ matcher, hooks: [hook] });
    store.hooks.set(event, matchers);
  }

  addFunctionHook(
    sessionId: string,
    event: HookEventName,
    matcher: string,
    callback: FunctionHookCallback,
    errorMessage: string,
    options?: { timeout?: number; id?: string },
  ): string {
    const store = this.getOrCreateStore(sessionId);
    const hookId = options?.id || generateId();

    const matchers = store.functionHooks.get(event) || [];
    matchers.push({
      matcher,
      hooks: [
        {
          type: 'function',
          id: hookId,
          callback,
          errorMessage,
          timeout: options?.timeout,
        },
      ],
    });
    store.functionHooks.set(event, matchers);

    return hookId;
  }

  removeFunctionHook(
    sessionId: string,
    event: HookEventName,
    hookId: string,
  ): void {
    // ...
  }

  clearSessionHooks(sessionId: string): void {
    this.sessionStores.delete(sessionId);
  }

  getSessionHooks(
    sessionId: string,
    event?: HookEventName,
  ): SessionHookMatcher[] {
    // ...
  }
}
```

**Skill Frontmatter 注册**：

```yaml
---
hooks:
  PreToolUse:
    - matcher: 'Write'
      hooks:
        - type: 'function'
          callback: 'validateWrite'
          errorMessage: 'Write validation failed'
---
```

#### 2.2 Hook 事件系统

**目标**：实时广播 hook 执行状态

**设计**：

```typescript
// packages/core/src/hooks/hookEvents.ts

interface HookStartedEvent {
  type: 'started';
  hookId: string;
  hookName: string;
  hookEvent: HookEventName;
  timestamp: number;
}

interface HookProgressEvent {
  type: 'progress';
  hookId: string;
  stdout: string;
  stderr: string;
  timestamp: number;
}

interface HookResponseEvent {
  type: 'response';
  hookId: string;
  hookName: string;
  hookEvent: HookEventName;
  outcome: 'success' | 'error' | 'cancelled';
  exitCode?: number;
  duration: number;
  timestamp: number;
}

type HookEventHandler = (event: HookEvent) => void;

class HookEventEmitter {
  private handlers: Set<HookEventHandler> = new Set();
  private enabled: boolean = true;

  registerHandler(handler: HookEventHandler): void {
    this.handlers.add(handler);
  }

  unregisterHandler(handler: HookEventHandler): void {
    this.handlers.delete(handler);
  }

  emitStarted(hookId: string, hookName: string, event: HookEventName): void {
    if (!this.enabled) return;
    this.emit({
      type: 'started',
      hookId,
      hookName,
      hookEvent: event,
      timestamp: Date.now(),
    });
  }

  emitProgress(hookId: string, stdout: string, stderr: string): void {
    if (!this.enabled) return;
    this.emit({
      type: 'progress',
      hookId,
      stdout,
      stderr,
      timestamp: Date.now(),
    });
  }

  emitResponse(hookId: string, result: HookExecutionResult): void {
    if (!this.enabled) return;
    this.emit({
      type: 'response',
      hookId,
      hookName: result.hookConfig.name || 'unknown',
      hookEvent: result.eventName,
      outcome: result.success ? 'success' : 'error',
      exitCode: result.exitCode,
      duration: result.duration,
      timestamp: Date.now(),
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private emit(event: HookEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (e) {
        // 忽略 handler 错误
      }
    }
  }
}
```

**UI 集成**：

- 在 CLI 中显示 hook 执行状态
- 通过事件系统更新 StatusLine

### Phase 3: 新事件类型

#### 3.1 StopFailure 事件

```typescript
enum HookEventName {
  // ... 现有事件
  StopFailure = 'StopFailure', // API 错误导致 turn 结束时
}

interface StopFailureInput extends HookInput {
  error: string;
  error_type:
    | 'rate_limit'
    | 'authentication_failed'
    | 'network_error'
    | 'other';
  is_timeout?: boolean;
}
```

**触发点**：在 API 调用失败时触发，替代 Stop 事件。

#### 3.2 PostCompact 事件

```typescript
enum HookEventName {
  // ... 现有事件
  PostCompact = 'PostCompact', // 对话压缩后
}

interface PostCompactInput extends HookInput {
  trigger: 'manual' | 'auto';
  original_tokens: number;
  compressed_tokens: number;
  summary: string;
}
```

**触发点**：在对话压缩完成后触发。

#### 3.3 PermissionDenied 事件

```typescript
enum HookEventName {
  // ... 现有事件
  PermissionDenied = 'PermissionDenied', // 自动模式分类器拒绝工具后
}

interface PermissionDeniedInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  reason: string;
}

interface PermissionDeniedOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PermissionDenied';
    retry?: boolean; // 让模型重试
  };
}
```

**触发点**：在自动模式分类器拒绝工具时触发。

#### 3.4 ConfigChange 事件

```typescript
enum HookEventName {
  // ... 现有事件
  ConfigChange = 'ConfigChange', // 配置文件变更时
}

interface ConfigChangeInput extends HookInput {
  source:
    | 'user_settings'
    | 'project_settings'
    | 'local_settings'
    | 'policy_settings'
    | 'skills';
  file_path: string;
  change_type: 'created' | 'modified' | 'deleted';
}
```

**触发点**：在配置文件变更时触发。

### Phase 4: 其他特性补齐

#### 4.1 if 条件过滤

```typescript
interface HookConfigBase {
  // ... 现有字段
  if?: string; // 权限规则语法条件
}

// 在 HookPlanner 中实现条件过滤
class HookPlanner {
  private evaluateCondition(
    condition: string,
    context: HookEventContext,
  ): boolean {
    // 解析权限规则语法
    // 例如: "tool_name == 'Bash' && tool_input.command contains 'rm'"
    return this.permissionRuleEngine.evaluate(condition, context);
  }
}
```

#### 4.2 once 标志

```typescript
interface HookConfigBase {
  // ... 现有字段
  once?: boolean; // 执行一次后移除
}

// 在 HookRunner 中实现
class HookRunner {
  async executeHook(hook: HookConfig, ...): Promise<HookExecutionResult> {
    const result = await this.doExecute(hook, ...);

    if (hook.once && result.success) {
      this.registry.removeHook(hook);
    }

    return result;
  }
}
```

#### 4.3 statusMessage

```typescript
interface HookConfigBase {
  // ... 现有字段
  statusMessage?: string; // 自定义状态消息
}

// 在 UI 中显示
// 替代默认的 "Running hook..." 消息
```

---

## 实施优先级与路线图

### P0 - 立即实施（核心能力）

| 任务             | 预估工作量 | 依赖 |
| ---------------- | ---------- | ---- |
| HttpHook 实现    | 2-3 天     | 无   |
| 异步 Hook 支持   | 2-3 天     | 无   |
| Session Hooks    | 2-3 天     | 无   |
| StopFailure 事件 | 1 天       | 无   |
| PostCompact 事件 | 1 天       | 无   |

### P1 - 短期实施（重要能力）

| 任务                  | 预估工作量 | 依赖                   |
| --------------------- | ---------- | ---------------------- |
| PromptHook 实现       | 3-5 天     | LLM Client             |
| Hook 事件系统         | 2-3 天     | 无                     |
| if 条件过滤           | 2-3 天     | Permission Rule Engine |
| PermissionDenied 事件 | 1 天       | 无                     |
| HookCallback 类型     | 1-2 天     | Session Hooks          |

### P2 - 中期实施（增强能力）

| 任务                     | 预估工作量 | 依赖                     |
| ------------------------ | ---------- | ------------------------ |
| AgentHook 实现           | 5-7 天     | PromptHook, Agent System |
| once 标志                | 1 天       | 无                       |
| statusMessage            | 1 天       | Hook 事件系统            |
| ConfigChange 事件        | 1-2 天     | File Watcher             |
| shell 选择（PowerShell） | 1-2 天     | 无                       |

### P3 - 长期实施（扩展能力）

| 任务                    | 预估工作量              | 依赖         |
| ----------------------- | ----------------------- | ------------ |
| Teammate/Task 事件      | 需整体团队协作功能      | Team System  |
| Elicitation 事件        | 需 MCP elicitation 支持 | MCP System   |
| Worktree 事件           | 需 Worktree 管理        | Git Worktree |
| CwdChanged/FileChanged  | 3-5 天                  | File Watcher |
| InstructionsLoaded 事件 | 1-2 天                  | 无           |

### 实施路线图

```
Week 1-2: P0 核心能力
├── HttpHook 实现
├── 异步 Hook 支持
├── Session Hooks
└── StopFailure/PostCompact 事件

Week 3-4: P1 重要能力
├── PromptHook 实现
├── Hook 事件系统
├── if 条件过滤
└── PermissionDenied 事件

Week 5-6: P2 增强能力
├── AgentHook 实现
├── once/statusMessage
├── ConfigChange 事件
└── shell 选择

Week 7+: P3 扩展能力
├── 团队协作相关事件
├── MCP Elicitation 事件
├── Worktree 事件
└── 文件监视事件
```

---

## 附录

### A. 类型定义完整版

```typescript
// packages/core/src/hooks/types.ts

enum HookType {
  Command = 'command',
  Prompt = 'prompt',
  Agent = 'agent',
  Http = 'http',
  Function = 'function',
  Callback = 'callback',
}

interface HookConfigBase {
  name?: string;
  description?: string;
  timeout?: number;
  source?: HooksConfigSource;
  if?: string;
  once?: boolean;
  statusMessage?: string;
}

interface CommandHookConfig extends HookConfigBase {
  type: 'command';
  command: string;
  shell?: 'bash' | 'powershell';
  env?: Record<string, string>;
  async?: boolean;
  asyncRewake?: boolean;
}

interface PromptHookConfig extends HookConfigBase {
  type: 'prompt';
  prompt: string;
  model?: string;
}

interface AgentHookConfig extends HookConfigBase {
  type: 'agent';
  prompt: string;
  model?: string;
}

interface HttpHookConfig extends HookConfigBase {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
}

interface FunctionHookConfig extends HookConfigBase {
  type: 'function';
  id?: string;
  callback: FunctionHookCallback;
  errorMessage: string;
}

interface CallbackHookConfig extends HookConfigBase {
  type: 'callback';
  callback: (input: HookInput, signal: AbortSignal) => Promise<HookOutput>;
  internal?: boolean;
}

type HookConfig =
  | CommandHookConfig
  | PromptHookConfig
  | AgentHookConfig
  | HttpHookConfig
  | FunctionHookConfig
  | CallbackHookConfig;
```

### B. 配置示例

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/security-check.sh",
            "name": "security-check",
            "timeout": 30000,
            "async": false
          },
          {
            "type": "http",
            "url": "https://api.example.com/validate",
            "name": "remote-validation",
            "headers": {
              "Authorization": "Bearer $API_TOKEN"
            },
            "allowedEnvVars": ["API_TOKEN"]
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Check if this file write operation is safe: $ARGUMENTS",
            "name": "llm-safety-check",
            "model": "qwen-turbo"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Session initialized'",
            "name": "init-log",
            "once": true
          }
        ]
      }
    ]
  }
}
```

### C. 参考文件索引

| 文件                                               | 功能          |
| -------------------------------------------------- | ------------- |
| `packages/core/src/hooks/hookSystem.ts`            | 主入口        |
| `packages/core/src/hooks/hookRegistry.ts`          | Hook 注册管理 |
| `packages/core/src/hooks/hookRunner.ts`            | Hook 执行引擎 |
| `packages/core/src/hooks/hookPlanner.ts`           | 执行计划创建  |
| `packages/core/src/hooks/hookAggregator.ts`        | 结果聚合      |
| `packages/core/src/hooks/hookEventHandler.ts`      | 事件触发      |
| `packages/core/src/hooks/types.ts`                 | 类型定义      |
| `docs/users/features/hooks.md`                     | 用户文档      |
| `integration-tests/hook-integration/hooks.test.ts` | 集成测试      |
