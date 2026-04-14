# Prompt Hook 类型设计文档

## 目录

1. [概述](#概述)
2. [Claude Code Prompt Hook 实现分析](#claude-code-prompt-hook-实现分析)
3. [与 Qwen Code 架构的集成方案](#与-qwen-code-架构的集成方案)
4. [类型定义](#类型定义)
5. [核心实现](#核心实现)
6. [Settings Schema 变更](#settings-schema-变更)
7. [HookRunner 变更](#hookrunner-变更)
8. [输出验证与错误处理](#输出验证与错误处理)
9. [配置示例](#配置示例)
10. [测试策略](#测试策略)
11. [与其他 Hook 类型的关系](#与其他-hook-类型的关系)

---

## 概述

Prompt Hook 是一种使用 LLM 评估条件的 Hook 类型。与 Command Hook 执行 Shell 命令不同，Prompt Hook 将 Hook 输入作为 LLM 提示词，让模型返回结构化的 JSON 判断结果（`{ ok: true }` 或 `{ ok: false, reason: "..." }`）。

**典型使用场景：**

- 安全评估：「这个命令是否危险？」
- 代码质量检查：「这段代码是否符合规范？」
- 意图理解：「用户的请求是否与某个操作匹配？」

---

## Claude Code Prompt Hook 实现分析

### 系统提示词

Claude Code 的 Prompt Hook 使用 Haiku（小模型）进行评估，系统提示词固定为：

```
You are evaluating a hook in Claude Code.

Your response must be a JSON object matching one of the following schemas:
1. If the condition is met, return: {"ok": true}
2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}
```

### 执行流程

1. 将 `$ARGUMENTS` 占位符替换为 JSON 格式的 Hook 输入
2. 构造用户消息（替换后的 prompt）
3. 使用上述系统提示词调用 LLM
4. 用 JSON Schema 验证响应：`{ ok: boolean, reason?: string }`
5. `ok: false` 时返回 blocking error（exit code 2 语义）；`ok: true` 时返回 success

### 关键设计特征

| 特征                | 说明                                            |
| ------------------- | ----------------------------------------------- |
| **单轮**            | 不允许多轮对话，一次生成即完成                  |
| **结构化输出**      | 强制 JSON Schema 输出，使用 Zod 校验            |
| **小模型**          | 默认使用 Haiku（最小最快的模型），可配置        |
| **$ARGUMENTS 替换** | 支持 `$ARGUMENTS`、`$ARGUMENTS[0]`、`$0` 等语法 |
| **超时**            | 默认 30s，可配置                                |
| **异步**            | 不支持异步，始终同步执行                        |
| **once 标志**       | 支持，执行一次后从注册中移除                    |
| **if 条件**         | 支持权限规则语法过滤                            |
| **statusMessage**   | 支持自定义状态消息                              |

### Claude Code 实现代码参考

```typescript
// execPromptHook.ts 核心逻辑
const messages: MessageParam[] = [
  {
    role: 'system',
    content: [
      {
        type: 'text',
        text: `You are evaluating a hook in Claude Code...`,
      },
    ],
  },
  { role: 'user', content: processedPrompt },
];

const response = await client.messages.create({
  messages,
  model: hook.model || 'haiku',
  max_tokens: 1000,
  // structured output enforcement
});

const parsed = hookResponseSchema().safeParse(json);
// ok=false -> blocking error; ok=true -> success
```

---

## 与 Qwen Code 架构的集成方案

### Qwen Code 现有架构

Qwen Code 的 Hook 系统采用 **HookSystem -> HookRegistry -> HookPlanner -> HookRunner -> HookAggregator** 的管道架构。当前 `HookType` 枚举仅有 `Command = 'command'` 一种类型。

**核心文件：**

| 文件                                          | 职责                                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| `packages/core/src/hooks/types.ts`            | 类型定义（HookType, HookConfig, HookInput, HookOutput） |
| `packages/core/src/hooks/hookSystem.ts`       | 主入口                                                  |
| `packages/core/src/hooks/hookRegistry.ts`     | 加载和验证 Hook 定义                                    |
| `packages/core/src/hooks/hookPlanner.ts`      | 匹配和创建执行计划                                      |
| `packages/core/src/hooks/hookRunner.ts`       | 执行 Hook                                               |
| `packages/core/src/hooks/hookAggregator.ts`   | 合并多个 Hook 输出                                      |
| `packages/core/src/hooks/hookEventHandler.ts` | 触发各类事件                                            |
| `packages/cli/src/config/settingsSchema.ts`   | Settings JSON Schema                                    |

### LLM 客户端集成

Qwen Code 已有 `BaseLlmClient.generateJson()` 方法，使用 **function calling** 方式强制 JSON Schema 输出。这正是 Prompt Hook 需要的能力。

**调用方式：**

```typescript
const result = await config.getBaseLlmClient().generateJson({
  model: hook.model || config.getModel(),
  contents: [{ role: 'user', parts: [{ text: processedPrompt }] }],
  schema: HOOK_RESPONSE_SCHEMA,
  systemInstruction: PROMPT_HOOK_SYSTEM_PROMPT,
  abortSignal,
});
```

### 集成点

Prompt Hook 的执行嵌入在现有 `HookRunner.execute()` 流程中：

- 在 `HookRunner` 中添加 `executePromptHook()` 方法
- 根据 `hook.type` 分派到不同的执行路径
- 输出格式与 Command Hook 统一，经 `HookAggregator` 合并

---

## 类型定义

### 新增 HookType

```typescript
// packages/core/src/hooks/types.ts

export enum HookType {
  Command = 'command',
  Prompt = 'prompt', // 新增
}
```

### PromptHookConfig 接口

```typescript
// packages/core/src/hooks/types.ts

export interface PromptHookConfig {
  type: HookType.Prompt;
  prompt: string; // LLM 评估的 prompt 模板，支持 $ARGUMENTS 占位符
  model?: string; // 可选的模型名称，默认使用配置中的模型
  timeout?: number; // 超时时间（ms），默认 30000
  name?: string; // Hook 名称（用于日志和错误信息）
  description?: string; // Hook 描述
  if?: string; // 权限规则语法条件过滤
  once?: boolean; // true = 执行一次后从注册中移除
  statusMessage?: string; // 自定义执行状态消息
  source?: HooksConfigSource; // 配置来源
}

export type HookConfig = CommandHookConfig | PromptHookConfig;
```

### 扩展 HookInput

无需为 Prompt Hook 创建专用的 Input 类型。所有事件特定的输入（如 `PreToolUseInput`）已继承自 `HookInput` 基类，`$ARGUMENTS` 占位符替换时会将其序列化为 JSON 字符串。

### 响应 Schema

```typescript
// packages/core/src/hooks/types.ts

export const PROMPT_HOOK_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: {
      type: 'boolean',
      description: 'Whether the hook condition was met',
    },
    reason: {
      type: 'string',
      description:
        'Reason for why the condition was not met (only present when ok is false)',
    },
  },
  required: ['ok'],
  additionalProperties: false,
};

export interface PromptHookResponse {
  ok: boolean;
  reason?: string;
}
```

---

## 核心实现

### PromptHookRunner

**文件：** `packages/core/src/hooks/execPromptHook.ts`

```typescript
import { BaseLlmClient, GenerateJsonOptions } from '../core/baseLlmClient.js';
import { Config } from '../config/config.js';
import {
  HookEventName,
  HookExecutionResult,
  HookOutput,
  PROMPT_HOOK_RESPONSE_SCHEMA,
  PromptHookConfig,
  PromptHookResponse,
} from './types.js';
import { substituteArguments } from './hookHelpers.js';

export const PROMPT_HOOK_SYSTEM_PROMPT =
  `You are evaluating a hook in Qwen Code.\n\n` +
  `Your response must be a JSON object matching one of the following schemas:\n` +
  `1. If the condition is met, return: {"ok": true}\n` +
  `2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}`;

export class PromptHookRunner {
  constructor(private readonly config: Config) {}

  async execute(
    hook: PromptHookConfig,
    eventName: HookEventName,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();

    // 1. 序列化输入为 JSON 用于 $ARGUMENTS 替换
    const jsonInput = JSON.stringify(input, null, 2);

    // 2. 替换占位符
    const processedPrompt = substituteArguments(
      hook.prompt,
      jsonInput,
      true, // appendIfNoPlaceholder
    );

    // 3. 构建 contents
    const { Content } = await import('@google/generative-ai');
    const contents: Content[] = [
      { role: 'user', parts: [{ text: processedPrompt }] },
    ];

    // 4. 调用 LLM
    const llmClient = this.config.getBaseLlmClient();
    const response = await llmClient.generateJson({
      model: hook.model || this.config.getModel(),
      contents,
      schema: PROMPT_HOOK_RESPONSE_SCHEMA,
      systemInstruction: PROMPT_HOOK_SYSTEM_PROMPT,
      abortSignal: signal,
      maxAttempts: 3,
    } as GenerateJsonOptions);

    // 5. 解析和校验响应
    const parsed = this.validateResponse(response);

    // 6. 构造结果
    const duration = Date.now() - startTime;
    const decision = parsed.ok ? 'allow' : 'deny';

    return {
      hookConfig: hook,
      eventName,
      success: parsed.ok,
      duration,
      exitCode: parsed.ok ? 0 : 2,
      output: {
        decision,
        reason: parsed.reason,
        hookSpecificOutput: {
          hookEventName: eventName,
          ...parsed,
        },
      },
    };
  }

  private validateResponse(
    response: Record<string, unknown>,
  ): PromptHookResponse {
    const schema = PROMPT_HOOK_RESPONSE_SCHEMA;

    // 校验 ok 字段存在且为 boolean
    if (typeof response['ok'] !== 'boolean') {
      throw new Error(
        `Prompt hook response validation failed: 'ok' must be a boolean, got: ${JSON.stringify(response)}`,
      );
    }

    // 校验 reason 字段（如果存在）必须为 string
    if ('reason' in response && typeof response['reason'] !== 'string') {
      throw new Error(
        `Prompt hook response validation failed: 'reason' must be a string if present`,
      );
    }

    // 校验无额外字段（additionalProperties: false）
    const allowedKeys = new Set(['ok', 'reason']);
    const extraKeys = Object.keys(response).filter((k) => !allowedKeys.has(k));
    if (extraKeys.length > 0) {
      throw new Error(
        `Prompt hook response contains unexpected keys: ${extraKeys.join(', ')}`,
      );
    }

    return {
      ok: response['ok'] as boolean,
      reason: response['reason'] as string | undefined,
    };
  }
}
```

### HookHelpers 占位符替换

`substituteArguments` 函数需在 `packages/core/src/hooks/hookHelpers.ts` 中实现（或复用已有的文本替换工具）：

```typescript
// packages/core/src/hooks/hookHelpers.ts

/**
 * 替换 prompt 中的 $ARGUMENTS 占位符。
 *
 * 支持的语法：
 *   $ARGUMENTS    - 完整 JSON 输入
 *   $ARGUMENTS[0] - 第一个分词参数
 *   $0, $1, ...   - 简写索引参数
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
): string {
  // 1. $ARGUMENTS[N] - 索引括号语法
  content = content.replace(
    /\$ARGUMENTS\[(\d+)\]/g,
    (_match, indexStr: string) => {
      const index = parseInt(indexStr, 10);
      const tokens = args ? safeParseArgs(args) : [];
      return tokens[index] ?? '';
    },
  );

  // 2. $N - 简写索引
  content = content.replace(/\$(\d+)(?!\w)/g, (_match, indexStr: string) => {
    const index = parseInt(indexStr, 10);
    const tokens = args ? safeParseArgs(args) : [];
    return tokens[index] ?? '';
  });

  // 3. $ARGUMENTS - 完整参数
  if (args !== undefined) {
    content = content.replaceAll('$ARGUMENTS', args);
  }

  // 4. 如果没有占位符且 appendIfNoPlaceholder=true，追加到末尾
  if (appendIfNoPlaceholder && !content.includes('$ARGUMENTS')) {
    content = `${content}\n\nArguments:\n${args ?? 'none'}`;
  }

  return content;
}

/**
 * 安全地解析 Shell 参数，支持引号内的空格。
 */
function safeParseArgs(input: string): string[] {
  try {
    // 优先使用 shell-quote 库
    const { parse } = require('shell-quote');
    const tokens = parse(input);
    return tokens.filter((t): t is string => typeof t === 'string');
  } catch {
    // 回退到简单分割
    return input.split(/\s+/).filter(Boolean);
  }
}
```

---

## Settings Schema 变更

在 `packages/cli/src/config/settingsSchema.ts` 中，需要扩展现有的 `HOOK_DEFINITION_ITEMS` 以接受 `prompt` 类型的 Hook。

### 当前 schema 结构（简化）

```typescript
// 当前仅有 command 类型
const HookItemSchema = z.object({
  type: z.literal('command').optional(),
  command: z.string(),
  name: z.string().optional(),
  // ...
});
```

### 变更后

```typescript
// packages/cli/src/config/settingsSchema.ts

// --- Command Hook 字段 ---
const CommandHookFields = {
  type: z.literal('command').optional().default('command'),
  command: z.string(),
  shell: z.enum(['bash', 'powershell']).optional(),
  env: z.record(z.string(), z.string()).optional(),
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(),
};

// --- Prompt Hook 字段 ---
const PromptHookFields = {
  type: z.literal('prompt'),
  prompt: z.string(),
  model: z.string().optional(),
};

// --- 公共字段 ---
const CommonHookFields = {
  name: z.string().optional(),
  description: z.string().optional(),
  timeout: z.number().positive().optional(),
  if: z.string().optional(),
  once: z.boolean().optional(),
  statusMessage: z.string().optional(),
};

// --- 使用 discriminated union ---
export const HookItemSchema = z.discriminatedUnion('type', [
  z.object({ ...CommonHookFields, ...CommandHookFields }),
  z.object({ ...CommonHookFields, ...PromptHookFields }),
]);
```

### JSON Schema 等价形式

如果 settings schema 使用纯 JSON Schema（非 Zod），则对应结构为：

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "type": { "const": "command" },
        "command": { "type": "string" },
        "name": { "type": "string" },
        "timeout": { "type": "number" },
        "once": { "type": "boolean" },
        "if": { "type": "string" },
        "statusMessage": { "type": "string" }
      },
      "required": ["command"]
    },
    {
      "type": "object",
      "properties": {
        "type": { "const": "prompt" },
        "prompt": { "type": "string" },
        "model": { "type": "string" },
        "name": { "type": "string" },
        "timeout": { "type": "number" },
        "once": { "type": "boolean" },
        "if": { "type": "string" },
        "statusMessage": { "type": "string" }
      },
      "required": ["type", "prompt"]
    }
  ]
}
```

---

## HookRunner 变更

**文件：** `packages/core/src/hooks/hookRunner.ts`

### 当前结构

```typescript
class HookRunner {
  async execute(
    hook: HookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    // 当前仅执行 command 类型
    return this.executeCommand(hook.command, input, signal);
  }
}
```

### 变更后

```typescript
class HookRunner {
  private promptRunner?: PromptHookRunner;

  constructor(private readonly config?: Config) {
    if (config) {
      this.promptRunner = new PromptHookRunner(config);
    }
  }

  async execute(
    hook: HookConfig,
    eventName: HookEventName,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const sig = signal ?? AbortSignal.timeout(hook.timeout ?? 60000);

    switch (hook.type) {
      case HookType.Prompt:
        if (!this.promptRunner) {
          throw new Error(
            'PromptHookRunner not available — Config not provided to HookRunner',
          );
        }
        return this.promptRunner.execute(hook, eventName, input, sig);

      case HookType.Command:
      default:
        return this.executeCommand(
          hook as CommandHookConfig,
          eventName,
          input,
          sig,
        );
    }
  }

  private async executeCommand(
    hook: CommandHookConfig,
    eventName: HookEventName,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HookExecutionResult> {
    // ... 现有逻辑保持不变 ...
  }
}
```

### 依赖注入

`HookRunner` 的构造函数需要可选接收 `Config` 实例：

- 在 `HookSystem` 构造时传入 `Config`
- `HookSystem` 将 `Config` 传递给 `HookRunner`
- `HookRunner` 用 `Config` 创建 `PromptHookRunner`
- 不影响 Command Hook 的执行路径（向后兼容）

### HookPlanner 变更

`HookPlanner` 需要更新其验证逻辑，接受 `type: 'prompt'` 作为有效类型，并确保 `prompt` 字段存在。

### HookRegistry 变更

`HookRegistry` 的 `validateHookConfig()` 方法需要增加对 `prompt` 类型的验证：

- 验证 `prompt` 字符串非空
- 验证 `model`（如果提供）是可用模型

---

## 输出验证与错误处理

### 响应校验

Prompt Hook 的响应校验分三层：

1. **LLM 层**：`BaseLlmClient.generateJson()` 使用 function calling 确保模型返回 JSON
2. **Schema 层**：`validateResponse()` 校验 JSON 结构符合 `PROMPT_HOOK_RESPONSE_SCHEMA`
3. **业务层**：根据 `ok` 字段决定 Hook 成功/失败

### 错误场景

| 错误类型         | Exit Code         | 行为                                         |
| ---------------- | ----------------- | -------------------------------------------- |
| LLM 调用超时     | 2（blocking）     | 显示超时错误给模型                           |
| LLM API 错误     | 2（blocking）     | 显示 API 错误给模型                          |
| 响应格式无效     | 1（non-blocking） | 记录警告，继续执行                           |
| `ok: false`      | 2（blocking）     | 将 `reason` 作为 stderr 显示给模型，阻止操作 |
| AbortSignal 中止 | 1（non-blocking） | 请求被取消，正常流程                         |

### 与 HookAggregator 的集成

Prompt Hook 的输出结构与现有 `HookOutput` 接口兼容：

```typescript
interface HookOutput {
  continue?: boolean; // ok=false 时设为 false
  stopReason?: string; // reason 字段填入
  decision?: 'allow' | 'deny'; // ok=true -> allow, ok=false -> deny
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;
}
```

`HookAggregator` 的合并逻辑不需要修改，因为它基于事件类型处理 `decision` 和 `continue` 字段，与 Hook 类型无关。

---

## 配置示例

### 基本 Prompt Hook

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Analyze the following Bash command for security risks (injection, data destruction, network exfiltration). Return ok:true if safe, ok:false with reason if dangerous:\n$ARGUMENTS",
            "name": "security-check"
          }
        ]
      }
    ]
  }
}
```

### 带条件过滤和一次性标志

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Is this file write operation safe? Consider the file path and content:\n$ARGUMENTS",
            "name": "write-safety-check",
            "if": "tool_input contains sensitive_path",
            "once": true,
            "statusMessage": "Running LLM write safety check..."
          }
        ]
      }
    ]
  }
}
```

### 指定模型

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Review the conversation transcript at $ARGUMENTS. Did the agent complete all tasks in the user's request? Return ok:true if yes, ok:false with missing items as reason.",
            "model": "qwen-turbo",
            "name": "task-completeness-check",
            "timeout": 45000
          }
        ]
      }
    ]
  }
}
```

### 带 $ARGUMENTS 索引参数

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "The following Bash command was executed:\n$ARGUMENTS[0]\n\nThe output was:\n$ARGUMENTS[1]\n\nWas the output as expected? Return ok:true if yes, ok:false with reason if unexpected.",
            "name": "output-validation"
          }
        ]
      }
    ]
  }
}
```

---

## 测试策略

### 单元测试

| 测试文件                 | 测试内容                |
| ------------------------ | ----------------------- |
| `execPromptHook.test.ts` | Prompt Hook 执行流程    |
| `hookHelpers.test.ts`    | `$ARGUMENTS` 占位符替换 |
| `hookRunner.test.ts`     | Hook 类型分派逻辑       |
| `settingsSchema.test.ts` | Prompt Hook 配置校验    |

### 测试用例列表

#### PromptHookRunner

1. **基础成功路径**：LLM 返回 `{ ok: true }`，Hook 执行成功
2. **基础失败路径**：LLM 返回 `{ ok: false, reason: "dangerous" }`，Hook 返回 blocking error
3. **超时处理**：LLM 调用超时，抛出 TimeoutError
4. **AbortSignal 处理**：信号中止时抛出 AbortError
5. **响应校验失败**：LLM 返回无效 JSON，校验错误
6. **自定义模型**：指定 `model` 字段时使用对应模型
7. **占位符替换**：`$ARGUMENTS`、`$0`、`$ARGUMENTS[0]` 正确替换
8. **无占位符追加**：prompt 不含占位符时，参数自动追加到末尾

#### HookHelpers

1. `$ARGUMENTS` 替换完整 JSON
2. `$ARGUMENTS[0]` / `$ARGUMENTS[1]` 索引替换
3. `$0` / `$1` 简写索引替换
4. 混合使用多种占位符
5. 无占位符时自动追加模式
6. Shell 引号内参数解析（如 `"hello world"` 作为一个参数）

#### HookRunner

1. `type: 'prompt'` 分派到 PromptHookRunner
2. `type: 'command'`（或无 type）分派到 Command Hook 路径
3. Config 未提供时 Prompt Hook 报错

#### Settings Schema

1. `type: "prompt"` + `prompt` 字段通过校验
2. `type: "prompt"` 缺少 `prompt` 字段报错
3. `type: "prompt"` + 可选字段（model, timeout, once 等）通过校验
4. 未知 type 值报错

### Mock 策略

所有测试使用 Mock `BaseLlmClient`：

```typescript
const mockLlmClient = {
  generateJson: vi.fn().mockResolvedValue({ ok: true }),
};

const mockConfig = {
  getBaseLlmClient: () => mockLlmClient,
  getModel: () => 'coder-model',
};
```

---

## 与其他 Hook 类型的关系

### 与 Command Hook 的对比

| 维度     | Command Hook                | Prompt Hook                  |
| -------- | --------------------------- | ---------------------------- |
| 执行方式 | Shell 进程（spawn）         | LLM API 调用（generateJson） |
| 输出来源 | stdout JSON                 | LLM JSON 响应                |
| 超时默认 | 60s                         | 30s                          |
| 异步支持 | 是（async/asyncRewake）     | 否（始终同步）               |
| 错误码   | 0=成功, 2=阻塞, 其他=非阻塞 | ok=true=成功, ok=false=阻塞  |
| 安全性   | 用户定义的命令              | 无 Shell 注入风险            |
| 资源开销 | 进程创建                    | API 调用延迟                 |

### 与未来 Hook 类型的关系

| 类型             | 与 Prompt Hook 的关系                                                   |
| ---------------- | ----------------------------------------------------------------------- |
| **AgentHook**    | 多轮版 Prompt Hook。共享系统提示词和响应校验逻辑，但使用完整 query 引擎 |
| **HttpHook**     | 完全独立的执行路径（HTTP POST 而非 LLM）                                |
| **FunctionHook** | TypeScript 回调，不需要 LLM                                             |
| **CallbackHook** | 内部回调，与 Prompt Hook 无直接关系                                     |

### 事件兼容性

Prompt Hook 可以用于所有现有的 12 种事件类型：

| 事件               | 适用场景                  |
| ------------------ | ------------------------- |
| PreToolUse         | 工具执行前的安全/权限评估 |
| PostToolUse        | 工具输出结果的验证        |
| PostToolUseFailure | 失败原因分析              |
| Notification       | 通知内容过滤              |
| UserPromptSubmit   | 用户意图理解              |
| SessionStart       | 初始化检查                |
| Stop               | 任务完成度验证            |
| SubagentStart      | 子代理配置验证            |
| SubagentStop       | 子代理结果验证            |
| PreCompact         | 压缩必要性判断            |
| SessionEnd         | 清理检查                  |
| PermissionRequest  | 权限决策辅助              |

---

## 实施 Checklist

- [ ] 在 `types.ts` 中添加 `HookType.Prompt` 枚举值
- [ ] 在 `types.ts` 中添加 `PromptHookConfig` 接口
- [ ] 在 `types.ts` 中添加 `PROMPT_HOOK_RESPONSE_SCHEMA` 和 `PromptHookResponse` 接口
- [ ] 在 `hookHelpers.ts` 中实现 `substituteArguments()` 函数
- [ ] 创建 `execPromptHook.ts` 和 `PromptHookRunner` 类
- [ ] 修改 `HookRunner.execute()` 添加类型分派逻辑
- [ ] 修改 `HookSystem` 构造函数接收 `Config` 并传递给 `HookRunner`
- [ ] 修改 `HookPlanner` 接受 `type: 'prompt'` 配置
- [ ] 修改 `HookRegistry.validateHookConfig()` 验证 Prompt Hook 字段
- [ ] 修改 `settingsSchema.ts` 的 HookItemSchema 支持 discriminated union
- [ ] 编写单元测试覆盖所有测试用例
- [ ] 编写集成测试验证端到端流程
