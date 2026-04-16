# Memory 记忆管理系统

> 本文介绍 Qwen Code 中 **Managed Auto-Memory**（托管自动记忆）的记忆管理机制、触发时机和实现细节。

---

## 目录

1. [概述](#概述)
2. [存储结构](#存储结构)
3. [记忆类型](#记忆类型)
4. [记忆条目格式](#记忆条目格式)
5. [核心生命周期](#核心生命周期)
6. [Extract — 提取](#extract--提取)
7. [Dream — 整合](#dream--整合)
8. [Recall — 召回](#recall--召回)
9. [Forget — 遗忘](#forget--遗忘)
10. [索引重建](#索引重建)
11. [遥测埋点](#遥测埋点)

---

## 概述

Managed Auto-Memory 是一套在 AI 会话过程中**自动**积累、整合和检索用户相关知识的持久化记忆系统。它通过四个核心操作维护记忆的生命周期：

| 操作 | 英文    | 触发方式                   | 作用                                   |
| ---- | ------- | -------------------------- | -------------------------------------- |
| 提取 | Extract | 自动（每轮对话后）         | 从对话记录中提炼新知识写入记忆文件     |
| 整合 | Dream   | 自动（周期性后台任务）     | 对记忆文件去重、合并，保持整洁         |
| 召回 | Recall  | 自动（每轮对话前）         | 检索与当前请求相关的记忆注入到系统提示 |
| 遗忘 | Forget  | 手动（用户命令 `/forget`） | 精确删除指定的记忆条目                 |

---

## 存储结构

### 目录布局

```
~/.qwen/                                      ← 全局基础目录（默认）
└── projects/
    └── <sanitized-git-root>/                 ← 项目标识（基于 Git 根路径）
        ├── meta.json                         ← 元数据（提取/整合时间戳、状态）
        ├── extract-cursor.json               ← 提取游标（已处理的对话偏移量）
        ├── consolidation.lock                ← Dream 进程互斥锁
        └── memory/                           ← 记忆主目录
            ├── MEMORY.md                     ← 索引文件（自动生成，汇总所有条目）
            ├── user.md                       ← 用户偏好记忆（示例）
            ├── feedback.md                   ← 反馈规范记忆（示例）
            ├── project/
            │   └── milestone.md              ← 项目记忆（支持子目录）
            └── reference/
                └── grafana.md                ← 外部资源记忆
```

> **环境变量覆盖**：
>
> - `QWEN_CODE_MEMORY_BASE_DIR`：替换全局基础目录
> - `QWEN_CODE_MEMORY_LOCAL=1`：改用项目内路径 `.qwen/memory/`

### 关键文件说明

| 文件                  | 说明                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `meta.json`           | 记录最后一次 Extract / Dream 的时间、会话 ID、涉及的记忆类型、执行状态 |
| `extract-cursor.json` | 记录当前会话已处理到对话历史的哪个偏移量，避免重复提取                 |
| `consolidation.lock`  | Dream 运行时的文件锁，内容为持有者 PID，超过 1 小时自动失效            |
| `MEMORY.md`           | 所有主题文件的索引，每次 Extract/Dream 后重建，格式为 Markdown 列表    |

---

## 记忆类型

系统支持四种内置记忆类型，每种对应不同的信息维度：

| 类型        | 存储内容                                              | 何时写入                                 | 何时读取                     |
| ----------- | ----------------------------------------------------- | ---------------------------------------- | ---------------------------- |
| `user`      | 用户的角色、技能背景、工作习惯                        | 了解到用户角色/偏好/知识背景时           | 回答需要根据用户背景定制时   |
| `feedback`  | 用户对 AI 行为的指导：避免什么、继续什么              | 用户纠正 AI 或确认某种非显而易见的做法时 | 影响 AI 行为方式时           |
| `project`   | 项目进展、目标、决策、截止日期、Bug 追踪              | 了解到谁在做什么、为什么、截止何时时     | 帮助 AI 理解工作背景和动机时 |
| `reference` | 外部系统资源指针（Dashboard、工单系统、Slack 频道等） | 得知某种外部资源及其用途时               | 用户提及外部系统或相关信息时 |

**不应该存入记忆的内容**：代码模式/约定、Git 历史、调试方案、临时任务状态、已在 QWEN.md/AGENTS.md 中记录的内容。

---

## 记忆条目格式

每个主题文件使用 **YAML frontmatter + Markdown body** 格式：

```markdown
---
name: 记忆名称
description: 一句话描述（用于判断召回相关性，要具体）
type: user|feedback|project|reference
---

记忆主体内容（summary 行）

Why: 背后原因（让 AI 能理解边界情况而不是盲目遵守规则）
How to apply: 适用场景和使用方式
```

对于 `feedback` 和 `project` 类型，强烈建议填写 `Why` 和 `How to apply`，使记忆在边界情况下仍能正确应用。

---

## 核心生命周期

```mermaid
flowchart TD
    A([用户发送请求]) --> B

    subgraph "召回 Recall"
        B[扫描所有主题文件] --> C{文档数量和\n查询内容是否有效?}
        C -- 否 --> D[返回空提示词\nstrategy: none]
        C -- 是 --> E{是否配置了 Config?}
        E -- 是 --> F[模型驱动选择\nside query]
        F --> G{选出相关文档?}
        G -- 是 --> H[strategy: model]
        G -- 否 --> I[strategy: none]
        E -- 否 --> J[启发式关键词评分]
        F -- 失败 --> J
        J --> K{有得分 > 0 的文档?}
        K -- 是 --> L[strategy: heuristic]
        K -- 否 --> I
        H --> M[构建 Relevant Memory 提示词\n注入系统提示]
        L --> M
        I --> N[不注入记忆]
    end

    M --> O([AI 处理请求])
    N --> O
    D --> O

    O --> P([AI 返回响应])

    subgraph "提取 Extract（后台）"
        P --> Q{本轮 AI 是否\n直接写了记忆文件?}
        Q -- 是 --> R[跳过\nmemory_tool]
        Q -- 否 --> S{提取任务是否\n正在运行?}
        S -- 是 --> T[放入队列或跳过\nalready_running / queued]
        S -- 否 --> U[加载未处理的对话切片\n基于 extract cursor]
        U --> V[调用提取 Agent\nrunAutoMemoryExtractionByAgent]
        V --> W[去重规范化 patches]
        W --> X{有 touched topics?}
        X -- 是 --> Y[更新 meta.json\n重建 MEMORY.md 索引]
        X -- 否 --> Z[仅更新 extract cursor]
        Y --> Z
    end

    subgraph "Dream 整合（后台，周期性）"
        P --> AA{Dream 调度门控检查}
        AA --> AB{是否同一会话?}
        AB -- 是 --> AC[跳过\nsame_session]
        AB -- 否 --> AD{距上次 Dream\n≥ 24 小时?}
        AD -- 否 --> AE[跳过\nmin_hours]
        AD -- 是 --> AF{距上次 Dream 后\n新会话数 ≥ 5?}
        AF -- 否 --> AG[跳过\nmin_sessions]
        AF -- 是 --> AH{consolidation.lock\n是否存在?}
        AH -- 是 --> AI[跳过\nlocked]
        AH -- 否 --> AJ[获取锁\n写入 PID]
        AJ --> AK{是否配置了 Config?}
        AK -- 是 --> AL[Agent 路径\nplanManagedAutoMemoryDreamByAgent]
        AL --> AM{Agent 是否触碰了文件?}
        AM -- 是 --> AN[记录触碰的 topics]
        AM -- "否/失败" --> AO
        AK -- 否 --> AO[机械去重路径\n解析+去重+按字母排序]
        AO --> AP[写回更新后的主题文件]
        AN --> AQ[重建 MEMORY.md 索引\n更新 meta.json]
        AP --> AQ
        AQ --> AR[释放锁]
    end
```

---

## Extract — 提取

### 触发时机

每次 AI 完成一轮响应后，由 `scheduleAutoMemoryExtract` 自动触发（后台非阻塞）。

### 调度逻辑（`extractScheduler.ts`）

```mermaid
flowchart TD
    A[scheduleAutoMemoryExtract 被调用] --> B{本轮历史记录中\n是否有写记忆文件的工具调用?}
    B -- 是 --> C[登记 skipped 任务\n原因: memory_tool]
    B -- 否 --> D{isExtractRunning?}
    D -- 是 --> E{是否已有 queued 请求?}
    E -- 是 --> F[更新 queued 请求的\nhistory 参数]
    E -- 否 --> G[注册 pending 任务\n放入 queue]
    D -- 否 --> H[注册 running 任务\n调用 runTask]
    H --> I[markExtractRunning\nsetCurrentTaskId]
    I --> J[runAutoMemoryExtract]
    J --> K[任务完成]
    K --> L[clearExtractRunning\n检查 queue → startQueuedIfNeeded]
    F --> M[返回 skipped: queued]
    G --> M
    C --> N[返回 skipped: memory_tool]
```

**跳过原因说明**：

| 原因              | 含义                                            |
| ----------------- | ----------------------------------------------- |
| `memory_tool`     | 本轮主 Agent 已直接写了记忆文件，跳过以避免冲突 |
| `already_running` | 提取正在进行且无法入队                          |
| `queued`          | 已有提取在运行，本次请求已入队                  |

### 核心提取流程（`extract.ts`）

```mermaid
flowchart TD
    A[runAutoMemoryExtract] --> B[ensureAutoMemoryScaffold\n初始化目录和文件]
    B --> C[buildTranscriptMessages\n将 Content[] 转换为带 offset 的消息列表]
    C --> D[readExtractCursor\n读取上次处理到的位置]
    D --> E[loadUnprocessedTranscriptSlice\n截取未处理的消息段]
    E --> F{slice 为空?}
    F -- 是 --> G[返回无 patches 结果]
    F -- 否 --> H[runAutoMemoryExtractionByAgent\n调用 forked agent 提取 patches]
    H --> I[dedupeExtractPatches\n去重+规范化]
    I --> J{有 touched topics?}
    J -- 是 --> K[bumpMetadata\n更新 meta.json]
    K --> L[rebuildManagedAutoMemoryIndex\n重建 MEMORY.md]
    L --> M[writeExtractCursor\n记录最新 offset]
    J -- 否 --> M
    M --> N[返回 AutoMemoryExtractResult]
```

**提取游标（Cursor）**：

- 字段：`{ sessionId, processedOffset, updatedAt }`
- 每次提取后更新 `processedOffset` 为当前历史长度
- 下次提取时，只处理 `offset >= processedOffset` 的消息
- 跨会话时（`sessionId` 变化）从偏移量 0 重新开始

**Patch 过滤规则**：

- 摘要长度 < 12 字符 → 丢弃
- 摘要以 `?` 结尾 → 丢弃（疑问句）
- 包含临时性关键词（today/now/currently/temporary 等）→ 丢弃
- 相同 `topic:summary` 组合 → 去重

---

## Dream — 整合

### 触发时机

每次 AI 完成一轮响应后，由 `scheduleManagedAutoMemoryDream` 自动触发（后台非阻塞）。但受多个门控条件保护，大多数情况下会被跳过。

### 调度门控（`dreamScheduler.ts`）

```mermaid
flowchart TD
    A[scheduleManagedAutoMemoryDream 被调用] --> B{Dream 功能是否启用?}
    B -- 否 --> C[跳过: disabled]
    B -- 是 --> D[ensureAutoMemoryScaffold\n读取 lastDreamSessionId]
    D --> E{当前 sessionId\n== lastDreamSessionId?}
    E -- 是 --> F[跳过: same_session]
    E -- 否 --> G{elapsedHours ≥ 24h\n或从未 dream?}
    G -- 否 --> H[跳过: min_hours]
    G -- 是 --> I{距上次 session scan\n< 10 分钟?}
    I -- 是 --> J[跳过: min_sessions\n等待下次扫描窗口]
    I -- 否 --> K[扫描 chats/*.jsonl mtime\n统计上次 Dream 后的新会话数]
    K --> L{新会话数 ≥ 5?}
    L -- 否 --> M[跳过: min_sessions]
    L -- 是 --> N{lockExists?\nPID 检查 + 过期检查}
    N -- 是 --> O[跳过: locked]
    N -- 否 --> P{dedupeKey 是否已有\n同项目 Dream 任务?}
    P -- 是 --> Q[跳过: running\n返回已有 taskId]
    P -- 否 --> R[调度后台任务\nBgTaskScheduler]
    R --> S[acquireDreamLock\n写入 PID 到 consolidation.lock]
    S --> T[runManagedAutoMemoryDream]
    T --> U[更新 meta.json\n释放锁]
```

**门控参数**：

| 参数                       | 默认值   | 说明                          |
| -------------------------- | -------- | ----------------------------- |
| `minHoursBetweenDreams`    | 24 小时  | 两次 Dream 之间的最小时间间隔 |
| `minSessionsBetweenDreams` | 5 个会话 | 触发 Dream 所需的最小新会话数 |
| `SESSION_SCAN_INTERVAL_MS` | 10 分钟  | 会话文件扫描的节流间隔        |
| `DREAM_LOCK_STALE_MS`      | 1 小时   | lock 文件被视为过期的时间阈值 |

**锁机制**：

- lock 文件位于 `<project-state-dir>/consolidation.lock`
- 内容为持有进程的 PID
- 检查时：若 PID 进程已不存在（`kill(pid, 0)` 失败）或 lock 超过 1 小时 → 视为过期，自动清除

### 整合执行流程（`dream.ts`）

```mermaid
flowchart TD
    A[runManagedAutoMemoryDream] --> B{是否配置了 Config?}
    B -- 是 --> C[Agent 路径\nplanManagedAutoMemoryDreamByAgent]
    C --> D{Agent 是否修改了文件?}
    D -- 是 --> E[从文件路径推断 touched topics]
    E --> F[bumpMetadata\n重建 MEMORY.md 索引]
    F --> G[updateDreamMetadataResult]
    G --> H[记录遥测事件]
    H --> I[返回结果]
    B -- 否 --> J[机械去重路径]
    C -- 抛出异常 --> J
    D -- 否 --> J

    J --> K[scanAutoMemoryTopicDocuments\n读取所有主题文件]
    K --> L[对每个文件执行 buildDreamedBody]
    L --> M[解析 entries → 按 summary 去重\n按字母升序排序 → 重新渲染]
    M --> N{body 有变化?}
    N -- 是 --> O[写回文件]
    O --> P[记录 touched topic]
    N --> Q[检查跨文件重复\ndedupeKey = type:summary]
    Q --> R{发现重复文件?}
    R -- 是 --> S[合并 entries 到 canonical 文件\n删除重复文件]
    S --> P
    R -- 否 --> T{有 touched topics?}
    P --> T
    T -- 是 --> U[bumpMetadata\n重建 MEMORY.md 索引]
    U --> V[updateDreamMetadataResult\n记录遥测 → 返回结果]
    T -- 否 --> V
```

**机械去重逻辑**：

1. 对每个主题文件内部：按 `summary.toLowerCase()` 去重，合并 `why`/`howToApply` 字段
2. 按 summary 字母顺序重新排序
3. 跨文件：相同 `type:summary` 的条目合并到最先发现的文件，删除重复文件

---

## Recall — 召回

### 触发时机

每轮 AI 处理用户请求之前，由 `resolveRelevantAutoMemoryPromptForQuery` 自动触发，将相关记忆注入系统提示词。

### 召回流程（`recall.ts`）

```mermaid
flowchart TD
    A[resolveRelevantAutoMemoryPromptForQuery] --> B[scanAutoMemoryTopicDocuments\n扫描所有主题文件]
    B --> C[filterExcludedAutoMemoryDocuments\n过滤本轮已写入的文件]
    C --> D{query 为空\n或 docs 为空\n或 limit <= 0?}
    D -- 是 --> E[返回空 prompt\nstrategy: none]
    D -- 否 --> F{是否配置了 Config?}
    F -- 是 --> G[selectRelevantAutoMemoryDocumentsByModel\n发起 side query 请求模型选择]
    G --> H{模型返回结果?}
    H -- 有文档 --> I[strategy: model]
    H -- 无文档 --> J[strategy: none\n仍然返回空]
    G -- "失败/异常" --> K[回退到启发式选择]
    F -- 否 --> K
    K --> L[tokenize query\n提取 ≥3 字符的 token]
    L --> M[scoreDocument 打分\n关键词匹配 +2 / 类型关键词 +1 / 有内容 +1]
    M --> N[过滤 score=0 的文档\n按分数降序排列，取 Top 5]
    N --> O{有得分文档?}
    O -- 是 --> P[strategy: heuristic]
    O -- 否 --> J
    I --> Q[buildRelevantAutoMemoryPrompt\n构建 Relevant Memory 区块]
    P --> Q
    Q --> R[返回注入主系统提示的 prompt 片段]
```

**评分规则（启发式）**：

| 条件                             | 加分             |
| -------------------------------- | ---------------- |
| query token 出现在文档内容中     | +2（每个 token） |
| query token 是该类型的特征关键词 | +1（每个 token） |
| 文档 body 非空                   | +1               |

**每种类型的特征关键词**：

- `user`：user, preference, background, role, terse
- `feedback`：feedback, rule, avoid, style, summary
- `project`：project, goal, incident, deadline, release
- `reference`：reference, dashboard, ticket, docs, link

**Prompt 构建规则**：

- 最多注入 5 篇文档（`MAX_RELEVANT_DOCS`）
- 每篇文档 body 截断至 1200 字符（`MAX_DOC_BODY_CHARS`）
- 超出截断时追加提示："NOTE: Relevant memory truncated for prompt budget."
- 包含文档的新鲜度信息（基于文件 mtime）

---

## Forget — 遗忘

### 触发时机

由用户手动执行 `/forget <query>` 命令触发。

### 遗忘流程（`forget.ts`）

```mermaid
flowchart TD
    A[forgetManagedAutoMemoryEntries\nquery + config] --> B[ensureAutoMemoryScaffold]
    B --> C[listIndexedForgetCandidates\n扫描所有文件的所有 entry]
    C --> D[为每个 entry 生成稳定 ID\n单 entry 文件: relativePath\n多 entry 文件: relativePath:index]
    D --> E{是否配置了 Config?}
    E -- 是 --> F[selectByModel\n构建 selection prompt\n发起 side query temperature=0]
    F --> G{模型选择成功?}
    G -- 是 --> H[strategy: model]
    G -- 失败 --> I[selectByHeuristic\n关键词匹配]
    E -- 否 --> I
    I --> J[strategy: heuristic]
    H --> K[遍历选中的 candidates]
    J --> K
    K --> L{entries.length == 1?}
    L -- 是 --> M[删除整个文件\nfs.unlink]
    L -- 否 --> N[解析文件中的所有 entries\n移除目标 entry\n重新渲染写回]
    M --> O[记录 removedEntries]
    N --> O
    O --> P{有 touched topics?}
    P -- 是 --> Q[bumpMetadata\n重建 MEMORY.md 索引]
    P --> R[返回 AutoMemoryForgetResult]
    Q --> R
```

**Entry ID 设计**：

- 单条目文件（常见情况）：`relativePath`（如 `feedback/no-summary.md`）
- 多条目文件：`relativePath:index`（如 `feedback/style.md:2`）
- 使用稳定 ID 使模型可以精确定位条目而不影响同文件的其他条目

---

## 索引重建

`MEMORY.md` 是所有主题文件的导航索引，每次 Extract 或 Dream 后调用 `rebuildManagedAutoMemoryIndex` 重建：

```
- [用户偏好](user/preferences.md) — 用户是资深 Go 工程师，第一次接触 React
- [反馈规范](feedback/style.md) — 保持回复简洁，不要尾部总结
- [项目里程碑](project/milestone.md) — 移动端发布切分支前的合并冻结窗口
```

**索引限制**：

- 每行最多 150 字符（超出用 `…` 截断）
- 最多 200 行
- 总大小不超过 25,000 字节

---

## 遥测埋点

系统内置三类遥测事件，用于监控记忆操作的性能和效果：

### Extract 遥测

| 字段             | 类型                        | 说明                    |
| ---------------- | --------------------------- | ----------------------- |
| `trigger`        | `'auto'`                    | 触发方式（当前仅自动）  |
| `status`         | `'completed'` \| `'failed'` | 执行结果                |
| `patches_count`  | number                      | 提取到的有效 patch 数量 |
| `touched_topics` | string[]                    | 被写入的记忆类型列表    |
| `duration_ms`    | number                      | 总耗时（毫秒）          |

### Dream 遥测

| 字段              | 类型                                  | 说明                   |
| ----------------- | ------------------------------------- | ---------------------- |
| `trigger`         | `'auto'`                              | 触发方式               |
| `status`          | `'updated'` \| `'noop'` \| `'failed'` | 执行结果               |
| `deduped_entries` | number                                | 机械路径去重的条目数量 |
| `touched_topics`  | string[]                              | 被修改的记忆类型列表   |
| `duration_ms`     | number                                | 总耗时（毫秒）         |

### Recall 遥测

| 字段            | 类型                                   | 说明             |
| --------------- | -------------------------------------- | ---------------- |
| `query_length`  | number                                 | 查询字符串长度   |
| `docs_scanned`  | number                                 | 扫描的文档总数   |
| `docs_selected` | number                                 | 最终注入的文档数 |
| `strategy`      | `'none'` \| `'heuristic'` \| `'model'` | 选择策略         |
| `duration_ms`   | number                                 | 总耗时（毫秒）   |

---

## 相关源文件索引

| 文件                                                 | 职责                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/core/src/memory/types.ts`                  | 类型定义：`AutoMemoryType`、`AutoMemoryMetadata`、`AutoMemoryExtractCursor`   |
| `packages/core/src/memory/paths.ts`                  | 路径计算：`getAutoMemoryRoot`、`isAutoMemPath`、各类文件路径 helpers          |
| `packages/core/src/memory/store.ts`                  | 脚手架初始化：`ensureAutoMemoryScaffold`，索引/元数据读写                     |
| `packages/core/src/memory/scan.ts`                   | 扫描主题文件：`scanAutoMemoryTopicDocuments`，解析 frontmatter                |
| `packages/core/src/memory/entries.ts`                | 条目解析和渲染：`parseAutoMemoryEntries`、`renderAutoMemoryBody`              |
| `packages/core/src/memory/extract.ts`                | 提取核心逻辑：`runAutoMemoryExtract`，游标管理，patch 去重                    |
| `packages/core/src/memory/extractScheduler.ts`       | 提取调度器：`ManagedAutoMemoryExtractRuntime`，队列/运行状态机                |
| `packages/core/src/memory/extractionAgentPlanner.ts` | 提取 Agent：`runAutoMemoryExtractionByAgent`                                  |
| `packages/core/src/memory/dream.ts`                  | 整合核心逻辑：`runManagedAutoMemoryDream`，Agent 路径 + 机械去重              |
| `packages/core/src/memory/dreamScheduler.ts`         | 整合调度器：`ManagedAutoMemoryDreamRuntime`，门控检查，锁管理                 |
| `packages/core/src/memory/dreamAgentPlanner.ts`      | 整合 Agent：`planManagedAutoMemoryDreamByAgent`                               |
| `packages/core/src/memory/recall.ts`                 | 召回逻辑：`resolveRelevantAutoMemoryPromptForQuery`，启发式+模型双路径        |
| `packages/core/src/memory/forget.ts`                 | 遗忘逻辑：`forgetManagedAutoMemoryEntries`，候选生成+精确删除                 |
| `packages/core/src/memory/indexer.ts`                | 索引重建：`rebuildManagedAutoMemoryIndex`，`buildManagedAutoMemoryIndex`      |
| `packages/core/src/memory/prompt.ts`                 | 系统提示模板：记忆类型说明、格式示例、使用规范                                |
| `packages/core/src/memory/governance.ts`             | 治理建议类型：`AutoMemoryGovernanceSuggestionType`                            |
| `packages/core/src/memory/state.ts`                  | 提取运行状态：`isExtractRunning`、`markExtractRunning`、`clearExtractRunning` |
| `packages/core/src/memory/memoryAge.ts`              | 新鲜度描述：`memoryAge`、`memoryFreshnessText`                                |
