# Skill Nudge：自动技能提炼系统设计文档

## 概述

本文档描述在 QwenCode 现有 Memory-Dream 架构基础上，增加 **Skill Nudge** 能力的设计方案。

Skill Nudge 是一种**程序性记忆自动提炼机制**：当 agent 完成了一个工具调用密集型任务后，系统在后台悄悄评估本次对话中是否存在值得复用的操作流程，并将其自动保存为项目级 skill。

### 与 Memory Extract 的定位差异

| 维度         | Memory Extract                   | Skill Nudge                    |
| ------------ | -------------------------------- | ------------------------------ |
| **记忆类型** | 陈述性记忆（用户是谁、项目背景） | 程序性记忆（如何做某类任务）   |
| **触发时机** | 每次会话结束后                   | 会话内工具调用达到阈值         |
| **写入目标** | `${projectRoot}/.qwen/memory/`   | `${projectRoot}/.qwen/skills/` |
| **内容性质** | 用户偏好、项目上下文、反馈规则   | 可复用的操作步骤、最佳实践     |
| **生命周期** | Dream 定期整合/修剪              | 按需更新，由 agent 主动维护    |

---

## 核心设计原则

1. **与 Extract 共享触发时机**：Skill Nudge 和 Memory Extract 都在会话结束后的同一个调度点触发，通过合并机制避免创建多个 forked agent。
2. **工具调用密度计数**：仅当本次会话内工具调用累计 ≥ 20 次才触发，确保只在真正复杂的任务后提炼。
3. **写保护边界明确**：`skill_manage` 只能操作当前项目的 project-level skill（`${projectRoot}/.qwen/skills/`），不能触碰 user / extension / bundled 层。
4. **最大保留 Hermes 核心 prompt**：review agent 使用的提示语直接移植自 Hermes `_SKILL_REVIEW_PROMPT`，只做最小化适配。

---

## 架构变更

### 1. 计数器：`toolCallCount`

在会话状态中增加一个工具调用计数器，由 agent 主循环维护。

```
会话启动
  toolCallCount = 0

每次工具调用完成
  toolCallCount += 1
  if (任意工具调用了 skill_manage):
    toolCallCount = 0   // 重置：已主动操作，无需 nudge

会话结束
  if (toolCallCount >= AUTO_SKILL_THRESHOLD):  // 默认 20
    _shouldReviewSkills = true
    toolCallCount = 0
```

**计数器重置条件**：会话期间只要有任意一次工具调用的函数名为 `skill_manage`，立即重置计数器。这防止模型刚主动创建/修改 skill 后又被 nudge 重复写入。

> **为何用工具调用次数而非对话轮次？**
> 工具调用次数反映任务复杂度——一个用户消息可能触发 1 次或 30 次工具调用。高工具密度意味着试错、调整策略等行为更多，产生可复用经验的概率也更高。阈值 20 比 Hermes 的 10 更保守，原因是 QwenCode 工具调用粒度通常更细（如逐行 edit）。

### 2. 调度点：与 Extract 合并

现有的 `MemoryManager.scheduleExtract()` 调用点（会话结束）作为统一调度入口，扩展为可同时调度 skill review。

```
会话结束
  ├─ scheduleExtract(params)           // 现有逻辑不变
  └─ scheduleSkillReview(params)       // 新增
       条件：_shouldReviewSkills === true

scheduleSkillReview 内部：
  检查是否有 extract 任务正在 pending/running
  ├─ 有 → 将 skill review 合并进同一个 forked agent（combined prompt）
  └─ 无 → 单独 fork skill review agent
```

**合并机制**：参考 Hermes 的 `_COMBINED_REVIEW_PROMPT`，当 extract 和 skill review 同时触发时，向同一个 forked agent 注入合并 prompt，一次 API 调用完成两件事，避免资源浪费。

### 3. `skill_manage` 在不同 agent 上下文中的可用性

系统中存在两类 forked agent，`skill_manage` 的可用性应明确区分：

| Agent 类型                              | 触发来源                     | `skill_manage`                  | 原因                               |
| --------------------------------------- | ---------------------------- | ------------------------------- | ---------------------------------- |
| **Skill Review Agent**（本机制引入）    | sessionEnd nudge（系统触发） | ✅ 可用，仅限 create/edit/patch | 专门用于写 skill，这是它的唯一职责 |
| **Task-execution subagent**（现有机制） | 主 agent 在任务中 fork       | ❌ 禁用                         | 见下文                             |

**Task-execution subagent 禁用 `skill_manage` 的原因**：

1. **用户意图未传递**：用户从未直接指令 subagent，由主 agent 决定 fork。Subagent 自行写 skill 超出了用户授权范围。
2. **缺乏全局视角**：Subagent 只看到子任务上下文，不知道主 agent 已经或即将触发 skill review，对"值得保存"缺乏判断依据。
3. **计数器干扰**：Subagent 调用 `skill_manage` 会触发主 agent 的计数器重置逻辑（`skill_manage` 被调用 → `toolCallCount = 0`），导致 sessionEnd 的 nudge 被错误跳过。
4. **噪声风险**：一次任务可能 fork 多个 subagent，若每个都能写 skill，`.qwen/skills/` 会被碎片化的局部经验填满。

**实现方式**：在 `fork-subagent` 的工具集继承逻辑中，显式将 `skill_manage` 加入 task-execution subagent 的排除列表。Skill review agent 作为专用 forked agent 独立配置，不走通用继承路径。

### 4. 权限沙箱：`SkillScopedPermissionManager`

参照 `extractionAgentPlanner.ts` 中的 `createMemoryScopedAgentConfig`，为 skill review agent 创建专用权限范围：

```typescript
// 仅允许以下操作
shell:        只读命令（Shell AST 静态分析，复用现有 isShellCommandReadOnlyAST）
edit:         仅限 ${projectRoot}/.qwen/skills/ 路径下的文件
write_file:   仅限 ${projectRoot}/.qwen/skills/ 路径下的文件
skill_manage: 允许所有 action（含 delete），但 delete 受调用来源约束（见下文）
```

**`delete` 的调用来源约束**：`skill_manage(action="delete")` 保留在工具集中，但通过 **system prompt 约束**而非 schema 限制来控制调用时机：

- **主 agent（用户直接交互）**：可以响应用户明确的删除指令（如"删除这个 skill"）调用 `delete`
- **review agent（Skill Nudge 后台触发）**：system prompt 中明确声明不得主动调用 `delete`，必须等待用户在后续对话中明确要求

review agent 的 system prompt 约束片段：

```
You are reviewing this conversation to extract reusable skills.
You may create new skills or update existing ones.
Do NOT delete any skills unless the user has explicitly requested deletion
in this conversation. Autonomous deletion is not permitted.
```

### 5. 新增工具：`skill_manage`（project-scope）

在 forked skill review agent 的工具集中注册一个 project-scoped 版本的 `skill_manage`：

```typescript
// 工具 schema（注册到 skill review agent 的工具集）
{
  name: "skill_manage",
  description: "Create or update a project-level skill in .qwen/skills/. " +
    "Use this to save reusable procedures, workflows, or approaches discovered in this session. " +
    "Skills are stored in the current project only.",
  parameters: {
    action: { enum: ["create", "edit", "patch", "write_file", "delete"] },
    name:   { type: "string" },
    content: { type: "string", description: "Full SKILL.md content for create/edit" },
    old_string: { type: "string", description: "For patch: text to find" },
    new_string: { type: "string", description: "For patch: replacement text" },
    category: { type: "string", description: "Optional subdirectory, e.g. 'typescript'" },
    file_path: { type: "string", description: "For write_file: relative path like 'references/api.md'" },
    file_content: { type: "string" }
  },
  required: ["action", "name"]
}
```

**写保护实现**：handler 在执行前验证目标路径必须在 `${projectRoot}/.qwen/skills/` 内，若尝试写入其他路径一律返回错误：

```typescript
function assertProjectSkillPath(targetPath: string, projectRoot: string): void {
  const projectSkillsDir = path.join(projectRoot, '.qwen', 'skills');
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(path.resolve(projectSkillsDir) + path.sep)) {
    throw new Error(
      `skill_manage can only write to ${projectSkillsDir}. ` +
        `Use the Skills UI to manage user or bundled skills.`,
    );
  }
}
```

---

## Skill Review Agent 设计

### 触发 prompt（移植自 Hermes，最小化适配）

**仅 skill review（独立触发）**：

```
Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial
and error, or changing course due to experiential findings along the way, or did
the user expect or desire a different method or outcome? If a relevant skill
already exists, update it with what you learned. Otherwise, create a new skill
if the approach is reusable.

If nothing is worth saving, just say 'Nothing to save.' and stop.

Skills are saved to the current project (.qwen/skills/). Use skill_manage to
create or update skills. Each skill requires a SKILL.md with YAML frontmatter:

---
name: <skill-name>
description: <one-line description>
---

<markdown body with the procedure/approach>
```

**合并 prompt（extract + skill review 同时触发）**：

```
Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — their persona,
desires, preferences, or personal details? Has the user expressed expectations
about how you should behave, their work style, or ways they want you to operate?
If so, save using the available memory write tools.

**Skills**: Was a non-trivial approach used to complete a task that required
trial and error, or changing course due to experiential findings along the way,
or did the user expect or desire a different method or outcome? If a relevant
skill already exists, update it with what you learned. Otherwise, create a new
skill if the approach is reusable.

Only act if there's something genuinely worth saving.
If nothing stands out, just say 'Nothing to save.' and stop.

Skills are saved to the current project (.qwen/skills/) via skill_manage.
Memory is saved to .qwen/memory/ via the memory write tools.
```

### Agent 配置

```typescript
{
  name: "managed-skill-extractor",
  tools: [
    "read_file",        // 读现有 skill 内容
    "list_directory",   // 扫描 .qwen/skills/ 目录
    "skill_manage",     // project-scoped 写入（见上文）
  ],
  permissionManager: createSkillScopedAgentConfig(config, projectRoot),
  // 传入完整对话历史快照（同 Hermes messages_snapshot）
  history: sessionHistory,
}
```

---

## 与现有 MemoryManager 的集成

### `ScheduleSkillReviewParams`（新增类型）

```typescript
export interface ScheduleSkillReviewParams {
  projectRoot: string;
  sessionId: string;
  history: Content[]; // 完整会话历史快照
  toolCallCount: number; // 本次会话的工具调用次数（用于日志/调试）
  config?: Config;
}

export interface SkillReviewScheduleResult {
  status: 'scheduled' | 'skipped' | 'merged';
  taskId?: string;
  mergedWithExtractTaskId?: string; // 若合并，记录 extract task id
  skippedReason?: 'below_threshold' | 'skill_manage_called' | 'disabled';
}
```

### `MemoryManager.scheduleSkillReview()`（新增方法）

```typescript
scheduleSkillReview(params: ScheduleSkillReviewParams): SkillReviewScheduleResult {
  // 1. 阈值检查
  if (params.toolCallCount < AUTO_SKILL_THRESHOLD) {
    return { status: 'skipped', skippedReason: 'below_threshold' };
  }

  // 2. 检查是否有 extract 任务正在 pending/running，可合并
  const pendingExtract = this.findPendingExtractTask(params.projectRoot);
  if (pendingExtract) {
    // 标记 extract 任务需要同时做 skill review（合并模式）
    this.mergeSkillReviewIntoExtract(pendingExtract.id, params);
    return {
      status: 'merged',
      mergedWithExtractTaskId: pendingExtract.id,
    };
  }

  // 3. 独立调度
  const record = makeTaskRecord('skill-review', params.projectRoot, params.sessionId);
  this.tasks.set(record.id, record);
  const promise = this.runSkillReview(record, params);
  this.inFlight.add(promise);
  promise.finally(() => this.inFlight.delete(promise));
  return { status: 'scheduled', taskId: record.id };
}
```

### 任务类型扩展

```typescript
// 扩展现有 MemoryTaskRecord.taskType
export type MemoryTaskType = 'extract' | 'dream' | 'skill-review';

// 新增常量
export const SKILL_REVIEW_TASK_TYPE = 'managed-skill-extractor' as const;
export const AUTO_SKILL_THRESHOLD = 20; // 工具调用次数阈值
```

---

## 数据流

```
会话进行中
  agent 主循环
    ├─ 每次工具调用 → toolCallCount += 1
    └─ 调用 skill_manage → toolCallCount = 0（重置）

会话结束（sessionEnd 事件）
  ├─ scheduleExtract(params)
  │     └─ [现有逻辑：fork extraction agent → 写 .qwen/memory/]
  │
  └─ toolCallCount >= 20 ?
       ├─ 否 → skip
       └─ 是 → scheduleSkillReview(params)
                 ├─ extract 正在 pending → 合并 prompt → 同一 forked agent
                 └─ extract 已运行/不存在 → 独立 fork skill review agent
                        ↓
                 skill review agent（max 8 轮，2 min，沙箱权限）
                 传入完整 sessionHistory
                        ↓
                 模型判断是否有可复用方法
                 ├─ 有 → skill_manage(create/patch)
                 │         → 写入 ${projectRoot}/.qwen/skills/
                 │         → SkillManager 缓存失效（notifyChangeListeners）
                 └─ 无 → "Nothing to save." 结束

下次会话
  SkillManager.listSkills({ level: 'project' })
  → 扫描 .qwen/skills/ 发现新建 skill
  → 注入 system prompt 的 <available_skills> 块（Tier 1）
```

---

## SKILL.md 格式约定（project-level）

自动提炼的 skill 写入 `${projectRoot}/.qwen/skills/<name>/SKILL.md`，格式与现有 SkillManager 完全兼容：

```yaml
---
name: <skill-name> # 必填，小写字母 + 连字符
description: <description> # 必填，≤ 1024 字符
# 以下字段可选
version: 1.0.0
metadata:
  source: auto-extracted # 标记为自动提炼，便于区分
  extracted_at: '2026-04-24T12:00:00Z'
---
# <技能标题>

<操作步骤 / 最佳实践 / 注意事项>
```

`metadata.source: auto-extracted` 字段为可选约定，便于用户在 UI 中区分自动提炼的 skill 和手动创建的 skill，不影响 SkillManager 的正常加载逻辑。

---

## 安全考量

| 风险                             | 缓解措施                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| 自动提炼覆盖用户精心编写的 skill | `create` 时检测同名 skill 已存在则改为 `patch`（追加/更新），不全量覆盖                          |
| skill 无限增长                   | review prompt 明确要求"优先更新已有 skill"；`patch` action 优于 `create`                         |
| 写入项目外路径                   | `assertProjectSkillPath` 路径白名单强制检查                                                      |
| 提炼出含注入风险的内容           | 复用现有 `skills_guard` 安全扫描（同 Hermes `_security_scan_skill`）                             |
| review agent 自行删除 skill      | review agent system prompt 明确禁止主动调用 `delete`；`delete` 仅在主 agent 中响应用户的明确指令 |
| 并发写入同一 skill               | `_atomic_write_text` 原子写入（tempfile + os.rename），同 Hermes                                 |

---

## 配置项

在 QwenCode config 中新增以下配置项（可选，有默认值）：

```typescript
// config schema 新增（在 memory 下）
memory?: {
  enableAutoSkill?: boolean;   // 默认 true
}
```

对应 QWEN.md / `~/.qwen/config.json` 配置示例：

```json
{
  "memory": {
    "enableAutoSkill": true
  }
}
```

---

## E2E 测试清单

功能实现完成后，按照 `.qwen/skills/e2e-testing/SKILL.md` 的流程，先执行 `npm run build && npm run bundle`，再使用本地构建产物 `node dist/cli.js` 进行端到端验证。

### 1. 低工具调用密度不触发

- 使用临时项目目录运行 headless 模式。
- 配置 `memory.enableAutoSkill: true`、较低但仍高于本用例工具调用次数的 `threshold`。
- 执行一个只需要少量工具调用的简单任务并正常结束会话。
- 断言 `.qwen/skills/` 未新增自动提炼 skill；JSON 流中不应出现 `skill_manage` 调用。

### 2. 达到阈值后触发 skill review

- 使用临时项目目录运行 headless 模式（`AUTO_SKILL_THRESHOLD` 硬编码为 20，可在测试夹具中调低）。
- 发送一个需要多次工具调用并包含可复用流程的任务。
- 断言会话结束后调度了 skill review；若模型判断值得保存，`.qwen/skills/<name>/SKILL.md` 被创建，且包含合法 YAML frontmatter。
- 若模型判断 `Nothing to save.`，断言流程正常结束且没有权限错误。

### 3. `skill_manage` 调用会重置 nudge 计数

- 构造一次会话，在达到阈值前后显式触发 `skill_manage`（或通过测试夹具模拟该工具调用）。
- 断言本轮 sessionEnd 不会再次自动调度重复的 skill review。
- 断言不会因同一会话内已主动管理 skill 而重复写入 `.qwen/skills/`。

### 4. 写保护只允许 project-level skills

- 通过 skill review agent 尝试写入项目外路径、user-level skill 路径或 bundled skill 路径。
- 断言写入被拒绝，错误信息指向只能写入 `${projectRoot}/.qwen/skills/`。
- 断言允许写入 `${projectRoot}/.qwen/skills/<name>/SKILL.md` 及其 skill 内部 reference 文件。

### 5. task-execution subagent 不暴露 `skill_manage`

- 运行一个会 fork task-execution subagent 的任务。
- 检查子 agent 的可用工具列表或 API logging 请求体。
- 断言 task-execution subagent 中没有 `skill_manage`，主会话工具计数不会被子 agent 的 skill 写入逻辑干扰。

### 6. Extract 与 Skill Review 合并触发

- 构造同时满足 memory extract 和 skill nudge 的会话。
- 断言只创建一个 forked review/extract agent 任务，且使用 combined prompt 同时处理 Memory 与 Skills。
- 断言 memory 写入仍落在 `.qwen/memory/`，skill 写入仍落在 `.qwen/skills/`。

### 7. 配置开关生效

- 配置 `memory.enableAutoSkill: false`，即使工具调用次数超过阈值也不触发。
- 验证默认开启时（`enableAutoSkill` 未配置或为 `true`），工具调用达到阈值后正常触发。

### 8. 本地构建产物验证

- 按 e2e-testing skill 使用 headless JSON 输出：
  `node dist/cli.js "<prompt>" --approval-mode yolo --output-format json 2>/dev/null`。
- 必要时加 `--openai-logging --openai-logging-dir <tmp-dir>` 检查请求体中的工具 schema、prompt 和权限配置。
- 对涉及 TUI 或 sessionEnd 可见状态的场景，使用 tmux interactive 流程捕获最终输出。

## 与现有系统的关系

```
现有 MemoryManager
  ├─ scheduleExtract()   ← 不变
  ├─ scheduleDream()     ← 不变
  ├─ recall()            ← 不变
  ├─ forget()            ← 不变
  └─ scheduleSkillReview()  ← 新增（本文档）

现有 SkillManager
  ├─ listSkills()        ← 不变（自动发现 .qwen/skills/ 下新增文件）
  ├─ loadSkill()         ← 不变
  └─ [write 能力]        ← 通过 skill_manage 工具暴露给 review agent

触发点（现有 sessionEnd hook）
  └─ 同时调用 scheduleExtract + scheduleSkillReview（条件满足时）
```

SkillManager 的读取侧（`listSkills`、`loadSkill`）完全不需要修改——review agent 写入 `${projectRoot}/.qwen/skills/` 后，`SkillManager` 通过现有的 `chokidar` 文件监听自动感知变化，调用 `notifyChangeListeners()` 触发缓存刷新，下次对话自然可以在 system prompt 中看到新 skill。
