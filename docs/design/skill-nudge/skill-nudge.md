# AutoSkill：自动技能提炼系统设计文档

## 概述

本文档描述在 QwenCode 现有 Memory-Dream 架构基础上，增加 **AutoSkill** 能力的设计方案。

AutoSkill 是一种**程序性记忆自动提炼机制**：当 agent 完成了一个工具调用密集型任务后，系统在后台悄悄评估本次对话中是否存在值得复用的操作流程，并将其自动保存为项目级 skill。

### 与 Memory Extract 的定位差异

| 维度         | Memory Extract                   | AutoSkill                      |
| ------------ | -------------------------------- | ------------------------------ |
| **记忆类型** | 陈述性记忆（用户是谁、项目背景） | 程序性记忆（如何做某类任务）   |
| **触发时机** | 每次会话结束后                   | 会话内工具调用达到阈值         |
| **写入目标** | `${projectRoot}/.qwen/memory/`   | `${projectRoot}/.qwen/skills/` |
| **内容性质** | 用户偏好、项目上下文、反馈规则   | 可复用的操作步骤、最佳实践     |
| **生命周期** | Dream 定期整合/修剪              | 按需更新，由 review agent 维护 |

---

## 核心设计原则

1. **无专用写入工具**：skill review agent 直接使用通用的 `read_file`、`write_file`、`edit` 工具操作 `.qwen/skills/`，不引入 `skill_manage` 专用工具。主会话同理——用户若要手动维护 skill，也使用相同的通用工具。
2. **技能变动检测代替工具计数重置**：参照 memory extract 检测 `memory_tool` 调用的方式，系统检测主会话中是否有任何写操作落在 `.qwen/skills/` 目录下。若有，说明用户本轮已主动操作 skill，session 结束时跳过自动 skill review。
3. **`auto-skill` 标识保护用户创建的 skill**：review agent 创建的 skill 在 YAML frontmatter 中必须包含 `source: auto-skill` 标记。skill review agent 只能修改带有此标记的 skill，不得触碰用户手工创建的 skill。
4. **工具调用密度触发**：仅当本次会话内工具调用累计 ≥ 20 次才触发，确保只在真正复杂的任务后提炼。
5. **写保护边界明确**：review agent 的权限管理器将 `write_file`、`edit` 限制在 `${projectRoot}/.qwen/skills/` 内，不能触碰 user / extension / bundled 层。
6. **最大保留 Hermes 核心 prompt**：review agent 使用的提示语直接移植自 Hermes `_SKILL_REVIEW_PROMPT`，只做最小化适配。

---

## 架构变更

### 1. 计数器：`toolCallCount` 与技能变动检测

在会话状态中维护两个并行追踪量：

**工具调用计数器**（决定是否触发 skill review）：

```
会话启动
  toolCallCount = 0

每次工具调用完成
  toolCallCount += 1

会话结束
  if (toolCallCount >= AUTO_SKILL_THRESHOLD):  // 默认 20
    检查 skillsModifiedInSession
    ├─ true  → skip（本轮已手动操作 skill，无需自动 review）
    └─ false → scheduleSkillReview()
```

**技能变动检测**（代替原来的 `skill_manage` 调用重置）：

```
每次工具调用完成
  if (工具调用的目标路径在 ${projectRoot}/.qwen/skills/ 下):
    skillsModifiedInSession = true
```

检测逻辑：扫描工具调用结果中涉及的文件路径，判断是否落在 skills 目录下。具体实现参照 `historyCallsSkillManage()` 的模式——遍历 `history` 中的 tool result，提取 `write_file`、`edit` 等写操作的目标路径进行前缀匹配。

> **为何用技能变动检测而非工具名检测？**
> 不再有专用的 `skill_manage` 工具，主会话和 review agent 都使用通用的 `write_file`/`edit`。因此检测维度从"是否调用了某个专用工具"转为"是否有写操作落在 `.qwen/skills/` 目录"，语义更准确：只要用户本轮已主动操作过 skill 文件，就跳过自动 review。

> **为何用工具调用次数而非对话轮次？**
> 工具调用次数反映任务复杂度——一个用户消息可能触发 1 次或 30 次工具调用。高工具密度意味着试错、调整策略等行为更多，产生可复用经验的概率也更高。阈值 20 比 Hermes 的 10 更保守，原因是 QwenCode 工具调用粒度通常更细（如逐行 edit）。

### 2. 调度点

现有的 `MemoryManager` 调用点（会话结束）作为统一调度入口，扩展为可同时调度 skill review。

```
会话结束
  ├─ scheduleExtract(params)           // 现有逻辑不变
  └─ scheduleSkillReview(params)       // 新增
       条件：toolCallCount >= AUTO_SKILL_THRESHOLD
             && !skillsModifiedInSession
```

extract 和 skill review 各自独立调度，通过 `MemoryManager.track()` 并行执行，互不阻塞。

### 3. Skill Review Agent 的工具访问权限

skill review agent **不使用** `skill_manage` 专用工具，而是直接使用通用文件工具：

| 工具         | 用途                                  | 范围限制                                                                    |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------- |
| `read_file`  | 读取现有 skill 内容，检查 frontmatter | 无限制                                                                      |
| `ls`         | 扫描 `.qwen/skills/` 目录结构         | 无限制                                                                      |
| `write_file` | 创建新 skill 文件                     | 仅限 `${projectRoot}/.qwen/skills/` 内                                      |
| `edit`       | 修改已有 skill 内容                   | 仅限 `${projectRoot}/.qwen/skills/` 内，且目标文件须含 `source: auto-skill` |
| `shell`      | 只读命令（如 `cat`、`find`）          | 仅允许只读命令（Shell AST 静态分析）                                        |

**对 `edit` 的额外约束（`auto-skill` 保护）**：

skill review agent 的权限管理器在执行 `edit` 或 `write_file`（对已有文件的覆盖写）前，读取目标文件的 YAML frontmatter，检查 `source: auto-skill` 字段。若该字段不存在，拒绝写入并返回错误：

```
skill_review_agent: edit is only allowed on skills with 'source: auto-skill' in frontmatter.
This skill appears to be user-created. Modify it manually or ask the user.
```

这一检查在 `createSkillScopedAgentConfig` 的权限层实现，而非仅靠 system prompt，确保即使模型出错也不会覆盖用户手工编写的 skill。

**主会话中的工具访问**：主 agent 不限制对 `.qwen/skills/` 的读写——用户可以通过正常的 `write_file`/`edit` 指令管理 skill。此类操作会触发 `skillsModifiedInSession = true`，导致 session 结束时跳过自动 skill review。

### 4. 权限沙箱：`SkillScopedPermissionManager`

参照 `extractionAgentPlanner.ts` 中的 `createMemoryScopedAgentConfig`，为 skill review agent 创建专用权限范围：

```typescript
// skill review agent 允许的操作
read_file:    无路径限制（需要读取任意文件来了解项目上下文）
ls:           无路径限制
shell:        只读命令（Shell AST 静态分析，复用现有 isShellCommandReadOnlyAST）
write_file:   仅限 ${projectRoot}/.qwen/skills/ 路径下的文件（创建新 skill）
edit:         仅限 ${projectRoot}/.qwen/skills/ 内，且目标文件含 source: auto-skill
```

**`auto-skill` 保护的实现层次**：

1. **权限管理器层**（硬约束）：`edit` 前读取 frontmatter，不含 `source: auto-skill` 则拒绝
2. **System prompt 层**（软约束）：明确告知 agent 只能修改带有 `source: auto-skill` 标记的 skill
3. **双重保障**：即使 system prompt 约束被绕过，权限管理器也会拦截

---

## Skill Review Agent 设计

### 触发 prompt（移植自 Hermes，最小化适配）

```
Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial
and error, or changing course due to experiential findings along the way, or did
the user expect or desire a different method or outcome? If a relevant skill
already exists and has 'source: auto-skill' in its frontmatter, update it with
what you learned. Otherwise, create a new skill if the approach is reusable.

IMPORTANT constraints:
- You may ONLY modify skill files that contain 'source: auto-skill' in their
  YAML frontmatter. Always read a skill file before editing it.
- Do NOT touch skills that lack this marker — they were created by the user.
- When creating a new skill, you MUST include 'source: auto-skill' in the
  frontmatter so future review agents can safely update it.
- Do NOT delete any skill. Only create or update.

If nothing is worth saving, just say 'Nothing to save.' and stop.

Skills are saved to the current project (.qwen/skills/).
Use write_file to create a new skill, edit to update an existing auto-skill.
Each skill lives at .qwen/skills/<name>/SKILL.md with YAML frontmatter:

---
name: <skill-name>
description: <one-line description>
metadata:
  source: auto-skill
  extracted_at: '<ISO-8601 timestamp>'
---

<markdown body with the procedure/approach>
```

### Agent 配置

```typescript
{
  name: "managed-skill-extractor",
  tools: [
    "read_file",   // 读现有 skill 内容，检查 source: auto-skill
    "ls",          // 扫描 .qwen/skills/ 目录
    "write_file",  // 创建新 skill 文件（权限管理器限制路径）
    "edit",        // 修改已有 auto-skill（权限管理器验证 frontmatter）
    "shell",       // 只读命令（如 find、cat）
  ],
  permissionManager: createSkillScopedAgentConfig(config, projectRoot),
  history: sessionHistory,  // 传入完整对话历史快照
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
  toolCallCount: number; // 本次会话的工具调用次数
  skillsModified: boolean; // 本次会话是否有写操作落在 .qwen/skills/
  config?: Config;
  enabled?: boolean;
  threshold?: number;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface SkillReviewScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?: 'below_threshold' | 'skills_modified_in_session' | 'disabled';
}
```

### `MemoryManager.scheduleSkillReview()`（新增方法）

```typescript
scheduleSkillReview(params: ScheduleSkillReviewParams): SkillReviewScheduleResult {
  // 1. 配置门控
  if (params.enabled === false) {
    return { status: 'skipped', skippedReason: 'disabled' };
  }

  // 2. 阈值检查
  const threshold = params.threshold ?? AUTO_SKILL_THRESHOLD;
  if (params.toolCallCount < threshold) {
    return { status: 'skipped', skippedReason: 'below_threshold' };
  }

  // 3. 本轮已主动操作 skill，跳过自动 review
  if (params.skillsModified) {
    return { status: 'skipped', skippedReason: 'skills_modified_in_session' };
  }

  // 4. 独立调度
  const record = makeTaskRecord('skill-review', params.projectRoot, params.sessionId);
  const promise = this.track(record.id, this.runSkillReview(record, params));
  return { status: 'scheduled', taskId: record.id, promise };
}
```

### 任务类型扩展

```typescript
// 扩展现有 MemoryTaskRecord.taskType
export type MemoryTaskType = 'extract' | 'dream' | 'skill-review';

// 常量
export const AUTO_SKILL_THRESHOLD = 20; // 工具调用次数阈值
```

---

## 数据流

```
会话进行中
  agent 主循环
    ├─ 每次工具调用 → toolCallCount += 1
    └─ 若写操作目标路径在 ${projectRoot}/.qwen/skills/ 下
         → skillsModifiedInSession = true

会话结束（sessionEnd 事件）
  ├─ scheduleExtract(params)
  │     └─ [现有逻辑：fork extraction agent → 写 .qwen/memory/]
  │
  └─ toolCallCount >= 20 && !skillsModifiedInSession ?
       ├─ 否 → skip（密度不足 或 本轮已手动操作 skill）
       └─ 是 → scheduleSkillReview(params)
                 └─ 独立 fork skill review agent
                        ↓
                 skill review agent（max 8 轮，2 min，沙箱权限）
                 工具：read_file, ls, write_file, edit, shell
                 传入完整 sessionHistory
                        ↓
                 模型判断是否有可复用方法
                 ├─ 有 → 读取已有 skill（检查 source: auto-skill）
                 │         → write_file 创建新 skill（含 source: auto-skill）
                 │         → edit 更新已有 auto-skill
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
version: 1.0.0
metadata:
  source: auto-skill # 必填（review agent 创建时强制写入）
  extracted_at: '2026-04-24T12:00:00Z'
---
# <技能标题>

<操作步骤 / 最佳实践 / 注意事项>
```

**`source: auto-skill` 的约束语义**：

| 标记值       | 创建方       | skill review agent 可修改？ | 用户可修改？ |
| ------------ | ------------ | --------------------------- | ------------ |
| `auto-skill` | review agent | ✅ 是                       | ✅ 是        |
| 无此字段     | 用户手工创建 | ❌ 否（权限管理器拦截）     | ✅ 是        |

用户若将自己创建的 skill 也加上 `source: auto-skill`，即表示允许 review agent 后续自动更新它。

---

## 安全考量

| 风险                                 | 缓解措施                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 自动提炼覆盖用户精心编写的 skill     | 权限管理器读取 frontmatter，无 `source: auto-skill` 则拒绝 `edit`；system prompt 也明确告知只能改 auto-skill     |
| skill 无限增长                       | review prompt 明确要求"优先更新已有 skill"；更新已有 skill 优于新建                                              |
| 写入项目外路径                       | `write_file`/`edit` 权限限制在 `${projectRoot}/.qwen/skills/` 内；`assertRealProjectSkillPath` 拒绝 symlink 穿越 |
| 提炼出含注入风险的内容               | 复用现有内容安全扫描逻辑                                                                                         |
| review agent 删除 skill              | review agent 工具集不含删除操作（无 `rm`、无 `shell` 写操作）；system prompt 明确禁止删除                        |
| 主会话手动操作 skill 后仍触发 review | `skillsModifiedInSession` 检测：主会话有写操作落在 `.qwen/skills/` 则跳过 review                                 |
| symlink 穿越写入 skills 目录外的文件 | `assertRealProjectSkillPath`（async）：用 `fs.realpath()` 解析真实路径，确认在真实 skills root 内才允许写入      |

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
- 配置 `memory.enableAutoSkill: true`。
- 执行一个只需要少量工具调用的简单任务并正常结束会话。
- 断言 `.qwen/skills/` 未新增 `source: auto-skill` skill；JSON 流中不应出现对 `.qwen/skills/` 的写操作。

### 2. 达到阈值后触发 skill review

- 使用临时项目目录运行 headless 模式（`AUTO_SKILL_THRESHOLD` 硬编码为 20，可在测试夹具中调低）。
- 发送一个需要多次工具调用并包含可复用流程的任务。
- 断言会话结束后调度了 skill review；若模型判断值得保存，`.qwen/skills/<name>/SKILL.md` 被创建，且 frontmatter 包含 `source: auto-skill`。
- 若模型判断 `Nothing to save.`，断言流程正常结束且没有权限错误。

### 3. 主会话操作 skill 后跳过 review

- 构造一次会话，在工具调用达到阈值的同时，通过 `write_file` 或 `edit` 写入 `.qwen/skills/` 下的文件（模拟用户手动管理 skill）。
- 断言 session 结束时 `skillsModifiedInSession = true`，`scheduleSkillReview` 返回 `skippedReason: 'skills_modified_in_session'`。
- 断言不会启动 review agent，避免重复写入。

### 4. 写保护只允许 project-level skills

- 通过 skill review agent 尝试写入项目外路径、user-level skill 路径或 bundled skill 路径。
- 断言写入被拒绝，错误信息指向只能写入 `${projectRoot}/.qwen/skills/`。
- 断言允许写入 `${projectRoot}/.qwen/skills/<name>/SKILL.md`。

### 5. `auto-skill` 标识保护用户创建的 skill

- 在 `.qwen/skills/` 中预置一个无 `source: auto-skill` 的用户创建 skill。
- 触发 skill review agent 并引导模型尝试修改该 skill。
- 断言写入被权限管理器拒绝，错误信息说明该 skill 不是 auto-skill。
- 断言同目录下带有 `source: auto-skill` 的 skill 可以正常更新。

### 6. symlink 穿越被拒绝

- 在 `.qwen/skills/` 下创建一个指向项目外目录的 symlink。
- 触发 skill review agent 尝试写入该 symlink 路径。
- 断言 `assertRealProjectSkillPath` 拒绝写入，返回 `symlink traversal detected` 错误。

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
  ├─ scheduleExtract()       ← 不变
  ├─ scheduleDream()         ← 不变
  ├─ recall()                ← 不变
  ├─ forget()                ← 不变
  └─ scheduleSkillReview()   ← 新增（本文档）

现有 SkillManager
  ├─ listSkills()            ← 不变（自动发现 .qwen/skills/ 下新增文件）
  └─ loadSkill()             ← 不变

现有文件工具（read_file / write_file / edit）
  ├─ 主会话中：用户可通过这些工具手动管理 skill
  │   └─ 写操作落在 .qwen/skills/ → skillsModifiedInSession = true
  └─ skill review agent 中：直接用于创建/更新 auto-skill
      └─ 权限管理器限制路径 + 验证 source: auto-skill

触发点（现有 sessionEnd hook）
  └─ 同时调用 scheduleExtract + scheduleSkillReview（条件满足时）
```

SkillManager 的读取侧（`listSkills`、`loadSkill`）完全不需要修改——review agent 写入 `${projectRoot}/.qwen/skills/` 后，`SkillManager` 通过现有的 `chokidar` 文件监听自动感知变化，调用 `notifyChangeListeners()` 触发缓存刷新，下次对话自然可以在 system prompt 中看到新 skill。
