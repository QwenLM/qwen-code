# Reliable Auto Memory Roadmap

Status: Proposed

Last updated: 2026-07-16

<details>
<summary><strong>中文评审参考（点击展开）</strong></summary>

> 本节是英文设计正文的中文评审版本，便于中文评审和方案讨论。英文正文是规范版本；如果两者出现表述差异，以英文正文及最终实现代码为准。

## 中文版：可靠 Auto Memory 演进方案

### 1. 目标与范围

本方案将当前 Auto Memory 从“后台 Agent 直接写正式记忆”演进为“候选生成、校验、审批、应用、检索、整理”的完整生命周期，同时保留 Markdown 作为最终持久化格式。

整体分为三个阶段、十二个可独立合并的 PR：

| 阶段    | 目标                 | PR 数 | 交付结果                                            |
| ------- | -------------------- | ----: | --------------------------------------------------- |
| Phase 1 | 可靠性、安全、可观测 |     4 | 首轮可靠召回、CJK fallback、秘密扫描、安全 Forget   |
| Phase 2 | 可信写入和人工治理   |     5 | Schema v2、候选基础设施、接入、Inbox、延迟提取      |
| Phase 3 | 检索质量和生命周期   |     3 | BM25 + 模型重排、多作用域整理、冲突、过期和预算控制 |

目标数据流：

```mermaid
flowchart LR
    A["对话或显式 Remember"] --> B["提取候选"]
    B --> C["Schema、来源和秘密校验"]
    C --> D["作用域和类型路由"]
    D --> E{"写入策略"}
    E -->|低风险私人写入| F["正式 Markdown Memory"]
    E -->|需要评审| G["Memory Inbox"]
    G -->|接受或编辑| F
    G -->|拒绝| H["审计结果"]
    F --> I["全量 Memory Catalog"]
    I --> J["Unicode/BM25 Fast Recall"]
    J --> K["模型重排"]
    K --> L["最多注入 5 个文档"]
    F --> M["按作用域 Consolidation"]
    M --> G
```

### 2. 全局设计约束

所有阶段必须遵守：

1. 正式记忆继续使用人类可读的 Markdown。
2. `MEMORY.md` 只能由框架生成，Agent 不再手工维护索引。
3. Memory 后台任务失败不能阻断用户主请求。
4. 一个逻辑轮次最多注入 5 个 Memory 文档。
5. 迟到的 Recall 结果不能直接复用到另一个 Query。
6. 秘密值不能进入错误、日志、Telemetry 和候选元数据。
7. Team Memory 的生成和整理必须可评审。
8. 不对历史 Memory 做破坏性批量迁移。
9. 自动覆盖和删除前必须检查并发冲突。
10. Recall、Extraction、Apply 和 Consolidation 都必须可衡量。

## 与主流 Coding CLI 的能力比较（截至 2026-07-16）

本节只比较跨 Session 的持久知识，不把对话恢复、Context Compaction、Instruction 文件或 Skill 本身等同于 Auto Memory。竞品能力变化较快，结论基于本仓库当前实现和下列官方资料：

- [Claude Code：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Codex：Memories](https://learn.chatgpt.com/docs/customization/memories)
- [Gemini CLI：Memory files](https://geminicli.com/docs/tools/memory/)
- [Gemini CLI：Configuration reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md#experimental)

### 能力快照

| 维度                 | Qwen Code 当前实现                                                             | Claude Code                                                             | Codex CLI                                                                                             | Gemini CLI                                                                            |
| -------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 持久指令与自动学习   | QWEN/AGENTS 指令与 Managed Memory 并存；支持显式 `/remember` 和后台 Extraction | `CLAUDE.md` 与 Auto Memory 分离；Auto Memory 默认开启，按价值自行记录   | `AGENTS.md` 与本地 Memories 分离；Memories 默认关闭                                                   | `GEMINI.md` 分层 Context；可通过工具直接保存，后台 Auto Memory 仍是默认关闭的实验能力 |
| 存储与作用域         | Markdown；User、Project、可选 Git-shared Team 三种作用域                       | 每 Repository 一个本地目录，跨 Worktree 共享；`MEMORY.md` 加 Topic 文件 | `~/.codex/memories/` 本地生成状态，包含摘要、持久条目、近期输入和证据                                 | Global、Private Project、Repository Shared 三层 Markdown                              |
| 写入时机             | 用户轮次后启动后台 Extraction；Project Dream 定期整理                          | 工作期间由 Claude 直接读写，未承诺每个 Session 都产生 Memory            | 跳过活跃或短任务，空闲足够久后后台生成；可受 Rate Limit 门槛约束                                      | `save_memory`/文件工具直接写；实验 Auto Memory 从历史 Session 后台提取 Patch          |
| Recall               | Model-primary，失败时使用 ASCII Heuristic；Topic 扫描在检索前截断 200          | 启动时加载 `MEMORY.md` 前 200 行或 25KB，Topic 按需读取                 | 在未来任务中按相关性注入本地 Memory；公开文档不承诺具体排序算法                                       | 保存内容自动进入分层 Context；公开文档不承诺独立相关性排序算法                        |
| 写入治理             | Extraction/Dream Agent 直接修改正式目录；Team 有额外限制                       | 直接写本地 Markdown；`/memory` 可浏览、编辑、删除和关闭                 | 生成文件可检查，提供任务级 Use/Contribute 控制；官方文档未描述写前 Inbox                              | 实验 Auto Memory 把 Unified Diff 放入 `/memory inbox`，批准前不应用                   |
| 来源、冲突和生命周期 | 当前没有稳定 ID、统一 Provenance、过期或 Supersedes 语义；仅 Project Dream     | 官方文档未描述结构化 Provenance、冲突或过期 Schema                      | 文件包含 Supporting Evidence，并有 Extraction/Global Consolidation；官方文档未描述用户可见冲突 Schema | 分层路由并避免跨层重复；实验 Patch 可评审，官方文档未描述统一过期 Schema              |
| 安全与隐私           | 当前 Secret Guard 只覆盖 Team；外部上下文和任务级隐身控制不足                  | Plain Markdown 可审计；官方 Memory 页面未承诺 Secret Scanner            | 生成字段会做 Secret Redaction，并支持禁止外部上下文任务贡献                                           | Plain Markdown 可审计；官方 Memory 页面未承诺 Secret Scanner                          |
| 用户控制             | `/remember`、`/forget`、`/dream`；当前 `/forget` 缺确认和跨操作治理            | `/memory` 查看文件、打开目录、切换 Auto Memory                          | `/memories` 分别控制当前任务是否读取和贡献                                                            | `/memory show/add/refresh`；实验 `/memory inbox` 评审 Patch                           |

“官方文档未描述”只表示不能从公开资料确认，不能直接推断竞品内部一定没有该能力。

### 当前相对位置

Qwen Code 当前的优势是作用域模型较完整：User、Project、Team 三层、显式 Remember/Forget、Project Dream 和 Git-shared Team Memory 已经形成基础闭环。相比只提供单一项目笔记的方案，它更接近团队知识治理系统。

主要差距按优先级为：

1. **写入可信度落后于 Gemini CLI 实验方案。** Agent 仍直接修改正式 Memory，没有 Patch/Candidate 隔离、写前评审、Digest 冲突检测和 Staging GC。
2. **提取时机落后于 Codex CLI。** 当前按用户轮次触发，容易处理过短或仍在进行的任务；缺少 Idle、Session 完成、Rate Limit、外部上下文和任务级 Contribute 门槛。
3. **Recall 可靠性和多语言能力不足。** 当前 Model-primary 的结果可能赶不上首轮消费，ASCII Heuristic 对 CJK 较弱，并且 200 文件预截断会造成系统性漏召回。
4. **审计体验落后于 Claude Code。** 虽有 Markdown，但缺少统一 Inbox/浏览入口来解释“写了什么、为什么写、何时使用、如何拒绝”。
5. **安全边界不一致。** Private Memory 写入没有与 Team 相同的 Secret Guard；`/forget` 也没有稳定预览、确认和进程内 Undo。
6. **知识生命周期不足。** 缺少稳定 ID、Provenance、Confidence、Expiry、Supersedes、跨作用域冲突和数据驱动的检索评估。

### 本路线图完成后的目标位置

本方案不以复制某一个竞品为目标，而是组合各方案已经验证的优点：

- 保留 Claude Code 的 Plain Markdown、简洁 Index 和按需 Topic 可审计性。
- 采用 Codex CLI 的延迟资格判断、任务级 Use/Contribute、外部上下文门槛、Secret Redaction 和独立 Extraction/Consolidation 控制。
- 采用 Gemini CLI 实验方案的 Staging Patch 和 Inbox-before-apply，同时增加 Digest 冲突检查、GC 和 Team 强制评审。
- 在竞品公开能力之上增加 Schema v2 Provenance、全作用域 Secret Guard、BM25 + Model Shadow Eval、Expiry/Supersedes 以及 Recall Delivery Telemetry。

完成 Phase 1 后应先达到“召回不丢、删除安全、所有作用域不写 Secret”；完成 Phase 2 后达到“自动写入可隔离、可评审、可回滚”；完成 Phase 3 后再以离线标注集和线上 Telemetry 证明检索质量，而不是仅凭功能数量宣称优于竞品。

---

## Phase 1：可靠性、安全、可观测

### PR 1.1：Recall 投递 Telemetry

建议提交：

```text
chore(memory): add recall delivery telemetry
```

#### 设计

现有 Recall Telemetry 只能表示“选择了多少文档”，无法证明文档真正进入主模型上下文。新增 `qwen-code.memory.recall_delivery`：

```ts
type RecallPhase = 'fast' | 'refined';
type RecallDeliveryPoint = 'initial' | 'tool_result' | 'discarded';
type RecallDiscardReason =
  | 'turn_completed_without_tool'
  | 'replaced_by_new_query'
  | 'user_abort'
  | 'reset_chat'
  | 'loop_detected'
  | 'session_limit'
  | 'shutdown'
  | 'error';
```

`loop_detected` 只表示现有 `LoopDetector` 判定并终止当前逻辑轮次；普通重复输出、用户取消和超时必须使用各自原因，不能归入该枚举。

只记录 phase、delivery point、discard reason、strategy、文档数量和耗时。禁止记录 Query、Memory 正文、文件路径、模型 reasoning 和 Session ID。

#### 涉及文件

| 文件                                                 | 变化                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/core/src/telemetry/constants.ts`           | 新增 Event 和 Metric 常量。                |
| `packages/core/src/telemetry/types.ts`               | 新增 Delivery Event；Recall 增加 phase。   |
| `packages/core/src/telemetry/loggers.ts`             | 新增 `logMemoryRecallDelivery`。           |
| `packages/core/src/telemetry/metrics.ts`             | 增加低基数 Counter 和耗时 Histogram。      |
| `packages/core/src/telemetry/index.ts`               | 导出新增 API。                             |
| `packages/core/src/core/client.ts`                   | 所有 Recall 取消点传递明确原因。           |
| `packages/core/src/memory/extractionAgentPlanner.ts` | 返回真实写入和触达文件数量。               |
| `packages/core/src/memory/extract.ts`                | 透传真实数量。                             |
| `packages/core/src/memory/manager.ts`                | 不再把 touched topic 数量当作 patch 数量。 |

旧 `patches_count` 和 `deduped_entries` 暂时保留以兼容 Dashboard，同时增加 `files_written_count`、`files_touched_count`、`touched_topics_count` 和 `deduped_entries_known`。

#### 验证

- 每个取消路径都有固定枚举的 discard reason。
- Telemetry 中没有 Query、正文、路径和秘密值。
- 真实文件数量与 Agent Result 一致。
- 每次完成的 Recall 选择最终都有 delivery 或 discard 结果。

### PR 1.2：Fast Recall 和 CJK 检索

建议提交：

```text
fix(memory): guarantee fast recall on the initial turn
```

#### 设计

Recall 拆成两个可灰度的阶段，但不直接把默认路径从 Model-primary 切换为 Heuristic-primary：

1. 项目和用户 Memory 只扫描一次。
2. 本地 Fast Recall 和现有 Model Recall 并发运行。
3. Model 在首轮预算内返回时优先使用其结果；否则只注入达到高置信阈值的 Fast 结果，最多 2 个，不为凑满配额注入弱相关文档。
4. Model Recall 继续异步运行，作为 Refined 结果。
5. 第一次 ToolResult 最多补充 3 个文档。
6. 没有 ToolResult 时丢弃 Refined，并记录 Telemetry。
7. 新 Query 到达时取消旧 Query 的 Refined 结果。
8. `fast 2 + refined 3` 是容量上限而非固定配额；总量始终不超过 5。

新增：

```ts
interface AutoMemoryRecallPlan {
  initial: Promise<RelevantAutoMemoryPromptResult>;
  refined: Promise<RelevantAutoMemoryPromptResult>;
}
```

CJK Tokenizer 使用 NFKC、ASCII token 和中日韩二元组：

```ts
const ASCII_TOKEN = /[a-z0-9]{3,}/gu;
const CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
```

单个 CJK 字符不参与宽泛 fallback。必须按 Unicode code point 切分。

二元组是 Phase 1 的低成本 fallback，而不是最终 CJK 分词方案。Phase 3 必须在多语言标注集上比较 bigram、`Intl.Segmenter` 和语言专用 Tokenizer 的 Recall、MRR、延迟、索引及 Bundle 成本；只有收益显著时才引入新依赖。

同时修正当前“非空正文无条件加分”的问题：没有 lexical match 时得分必须为 0，type/scope 只能在已有匹配上加权。

#### 涉及文件

| 文件                                                           | 变化                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/core/src/memory/recall.ts`                           | Recall Plan、共享扫描、Unicode Tokenizer、评分修复。 |
| `packages/core/src/memory/relevanceSelector.ts`                | 接收剩余额度和已排除路径。                           |
| `packages/core/src/memory/manager.ts`                          | 暴露 `createRecallPlan`。                            |
| `packages/core/src/core/client.ts`                             | 首轮 await Fast，只保留 Refined Prefetch。           |
| `packages/core/src/memory/recall.test.ts`                      | CJK、混合语言和评分测试。                            |
| `packages/core/src/memory/relevanceSelector.test.ts`           | 去重和剩余额度测试。                                 |
| `packages/core/src/core/client.test.ts`                        | 投递和取消生命周期。                                 |
| `packages/core/src/memory/memoryLifecycle.integration.test.ts` | 两阶段完整链路。                                     |

#### 验证

- Model Recall 永不结束时，达到高置信阈值的中文 Memory 仍进入首轮 Prompt。
- 无工具调用时 Fast 生效，Refined 被正确丢弃。
- Fast 最多 2 条且允许为 0，合计最多 5 条。
- 同一路径不重复注入。
- 中文、日文、韩文、英文和混合 Query 均有确定性行为。
- Fast Recall P95 小于 100ms，首轮附加 P95 小于 150ms。
- 先以内部 Rollout Flag 保持 Model-primary 并对比两套结果；只有离线 Recall@5/MRR、无关结果率及线上投递指标不退化时才启用 Hybrid。公开的 `retrievalMode` 配置在 Phase 3 引入。

### PR 1.3：所有 Managed Memory 的秘密扫描

建议提交：

```text
fix(memory): block secrets in all managed memory scopes
```

#### 设计

将 `team-memory-secret-guard.ts` 泛化并重命名为 `managed-memory-secret-guard.ts`，覆盖 `project`、`user`、`team` 三种作用域。

新增 realpath-aware 的 `getManagedMemoryScope()`，必须处理新文件、父目录符号链接、`..` 路径逃逸和路径前缀碰撞。

`write_file` 和 `edit` 的 validation/execute 都必须调用统一 Guard；`edit` 扫描最终完整文件，而不是只扫描 `new_string`。

新写入的单个 Memory 文档上限为 64 KiB，超限时在扫描前拒绝；已有超限文档仍可读取，但必须缩小后才能再次写入。增加 64 KiB 和 1 MiB 输入基准，确保秘密扫描保持线性且不会拖慢普通编辑。

#### 涉及文件

| 文件                                                   | 变化                             |
| ------------------------------------------------------ | -------------------------------- |
| `packages/core/src/memory/paths.ts`                    | 安全的作用域识别。               |
| `packages/core/src/memory/team-memory-secret-guard.ts` | 重命名并覆盖全部作用域。         |
| `packages/core/src/tools/write-file.ts`                | validation 和 execute 统一扫描。 |
| `packages/core/src/tools/edit.ts`                      | 扫描最终完整内容。               |
| `docs/users/features/memory.md`                        | 更新安全能力和边界。             |

新增 `managed-memory-secret-guard.test.ts` 和 `managed-memory-paths.test.ts`，扩展 `write-file.test.ts`、`edit.test.ts`。

#### 验证

- 三种作用域写凭证都被拒绝。
- 多次编辑拼接成 Token 时被拒绝。
- 已有秘密未清除时不能执行无关编辑。
- 错误和 Telemetry 不包含秘密原文。
- 普通代码文件不受 Memory Guard 影响。
- 符号链接和路径逃逸不能绕过。

Phase 1 不自动清理历史秘密；历史审计应单独设计。

### PR 1.4：安全的 `/forget`

建议提交：

```text
fix(memory): confirm and undo forget operations
```

#### 设计

第一次 `/forget <query>` 只选择并展示候选，返回现有 `confirm_action`，不修改文件。确认时必须使用用户第一次看到的候选，不能重新调用模型选择。

待确认候选缓存：最多 20 条、TTL 5 分钟、按 project root 和原始命令隔离。缓存过期或项目变化时重新展示，禁止直接删除。

提供进程内 `/forget --undo [operation-id]`：最多保留 10 条记录、TTL 30 分钟，不把已删除正文持久化到磁盘。Undo 前检查当前文件 hash；任一文件冲突时整体拒绝恢复。

确认界面和删除结果必须明确提示 Undo 仅在当前进程有效。默认不提供持久化 JSON 或 `.trash`，因为它们会保留用户明确要求遗忘的秘密或私人内容。跨重启 Undo 若未来确有需求，必须作为默认关闭、短 TTL、权限受限且支持永久删除的独立隐私设计。

#### 涉及文件

| 文件                                                       | 变化                            |
| ---------------------------------------------------------- | ------------------------------- |
| `packages/core/src/memory/forget.ts`                       | 快照、hash、恢复和冲突预检。    |
| `packages/core/src/memory/manager.ts`                      | Undo Registry 和 `undoForget`。 |
| `packages/cli/src/ui/commands/forgetCommand.ts`            | 预览、确认缓存和 `--undo`。     |
| `packages/core/src/memory/forget.test.ts`                  | 删除、恢复和冲突。              |
| `packages/core/src/memory/manager.test.ts`                 | TTL、上限和项目隔离。           |
| `packages/cli/src/ui/commands/forgetCommand.test.ts`       | 确认前零修改和候选一致性。      |
| `packages/cli/src/ui/hooks/slashCommandProcessor.test.ts`  | 确认命令重放。                  |
| `packages/cli/src/acp-integration/session/Session.test.ts` | ACP 不能绕过确认。              |

第一阶段不提供 `--yes` 绕过。

---

## Phase 2：可信写入和人工治理

### PR 2.1：Memory Schema v2 和来源证据

建议提交：

```text
feat(memory): add provenance-aware memory schema v2
```

#### 设计

正式 Memory 继续一条一个 Markdown 文件，在 Frontmatter 中增加：

```yaml
version: 2
id: mem_550e8400-e29b-41d4-a716-446655440000
type: project
scope: project
name: Release merge freeze
description: Non-critical merges are frozen during the mobile release.
confidence: asserted
status: active
created_at: 2026-07-16T10:00:00.000Z
updated_at: 2026-07-16T10:00:00.000Z
last_verified_at: 2026-07-16T10:00:00.000Z
source_kind: user_message
context_origin: local
```

Memory ID 使用 `mem_${crypto.randomUUID()}`，Candidate ID 同理使用 `cand_${crypto.randomUUID()}`，避免为 ULID 引入新依赖。`confidence` 为 `explicit | asserted | inferred`；`status` 为 `active | superseded | expired`。

`expires_at`、`supersedes`、`last_verified_at` 等可选字段只在有值时写入，不输出空字段。`source_kind` 表示谁或什么产生了断言；正交的 `context_origin: local | external | mixed` 表示证据是否依赖外部上下文。详细的 `source_session_id` 和 `source_message_ids` 存入按 Memory ID 索引的私人 Sidecar，不写入正式 Frontmatter。工具来源使用 `source_kind: tool_output`，不再使用与 `context_origin` 重叠的 `external_context`。Team Memory 接受时清除私人来源 ID，改为 `source_kind: team_review`。

兼容策略：无 `version` 视为 v1；读取 v1 不写回；v1 被更新时才写成 v2；不做启动时批量迁移。

#### 涉及文件

新增：

```text
packages/core/src/memory/memory-document.ts
packages/core/src/memory/memory-document.test.ts
packages/core/src/memory/memory-provenance-store.ts
packages/core/src/memory/memory-provenance-store.test.ts
```

修改：

| 文件                                                 | 变化                          |
| ---------------------------------------------------- | ----------------------------- |
| `packages/core/src/memory/types.ts`                  | v2 类型和版本。               |
| `packages/core/src/memory/entries.ts`                | 只负责正文，不解析 metadata。 |
| `packages/core/src/memory/scan.ts`                   | 使用统一 Document Parser。    |
| `packages/core/src/memory/indexer.ts`                | 只索引 active 文档。          |
| `packages/core/src/memory/prompt.ts`                 | Schema 和 confidence 规则。   |
| `packages/core/src/memory/extractionAgentPlanner.ts` | 提供来源上下文。              |
| `packages/core/src/memory/remember.ts`               | `/remember` 写 explicit。     |
| `packages/core/src/memory/forget.ts`                 | 优先使用稳定 Memory ID。      |
| `packages/core/src/memory/dreamAgentPlanner.ts`      | 维护验证和 supersedes。       |
| `packages/core/src/memory/store.ts`                  | 更新 Scaffold。               |

#### 验证

- v1/v2 均可解析和渲染。
- 只读 v1 时文件字节不变化。
- v1 更新后成为合法 v2。
- 单个坏文档不会导致全量扫描失败。
- Team 序列化会清除私人来源。
- 空的可选字段不会被序列化。
- CRLF、Unicode、YAML 引号和数组均可 round-trip。

### PR 2.2a：Candidate Staging 基础设施

建议提交：

```text
feat(memory): add auto-memory candidate staging
```

#### 设计

先增加不接入现有 Extraction 的纯 Core 基础设施：

1. 框架快照用户/项目 Memory。
2. 将快照复制到任务 staging 目录。
3. 比较 original/proposed，生成 Create/Update/Delete Candidate。
4. 校验路径、Schema、来源和秘密。
5. 提供 Candidate Store、状态迁移、容量限制和 GC。

本 PR 不改变现有写入路径，不新增 UI；基础设施以未接入或测试夹具方式存在，从而可以独立评审。

Staging 位于：

```text
~/.qwen/projects/<project>/memory-candidates/<task-id>/
  manifest.json
  original/
  proposed/
```

Candidate 保存 `action`、`scope`、目标相对路径、`baseDigest`、建议内容、来源、状态和校验错误。Apply 时当前目标 digest 必须等于 `baseDigest`，否则标记 conflicted，不能覆盖。Candidate ID 使用 `cand_${crypto.randomUUID()}`。

#### Staging 生命周期和 GC

- accepted/rejected 后立即删除 `original/` 和 `proposed/` 正文，只保留脱敏审计 Manifest 7 天。
- `running` 且超过 24 小时的孤儿任务自动清理。
- 损坏 Manifest 移入 quarantine、告警一次，最多保留 7 天。
- Pending Candidate 默认保留 30 天，之后标记 expired 并清理。
- 每项目最多 100 个 Pending Candidate 或 50 MiB；达到任一上限后停止新的自动 Candidate 生成并告警，不能静默丢弃。
- GC 在 Session 启动和 Candidate 处理完成后执行，必须 best-effort，失败不能阻塞主请求。

#### 文件

新增：

```text
packages/core/src/memory/candidates.ts
packages/core/src/memory/candidates.test.ts
packages/core/src/memory/candidate-store.ts
packages/core/src/memory/candidate-store.test.ts
packages/core/src/memory/memory-snapshot.ts
packages/core/src/memory/memory-snapshot.test.ts
packages/core/src/memory/candidate-gc.ts
packages/core/src/memory/candidate-gc.test.ts
```

修改 `paths.ts` 和 Core 导出入口，只暴露尚未接入行为的 Candidate API。

#### 验证

- Create/Update/Delete Diff 产生确定 Candidate。
- Agent/Staging 路径不能逃逸项目 Candidate 根目录。
- Pending 可跨重启读取，一个损坏 Manifest 不隐藏其他 Candidate。
- 已处理正文立即删除，审计 Manifest、孤儿、quarantine 和 pending TTL 正确执行。
- 100 条/50 MiB 上限停止新任务但不删除 Pending。
- GC 失败不影响 Session 启动。

### PR 2.2b：Extraction 接入 Staging

建议提交：

```text
feat(memory): route extraction through candidate staging
```

#### 设计

Extraction 和 Consolidation Agent 不再直接编辑正式 Memory：Agent 只能修改 staging 副本，框架将 Diff 转为 Candidate；只有 Apply 后才修改正式文件并重建索引。

写入策略：

```ts
type MemoryWritePolicy = 'off' | 'review' | 'auto-private';
```

Team Candidate 永远进入 Inbox，不提供未评审 Team 自动写入。

修改 `memory-scoped-agent-config.ts`、`extractionAgentPlanner.ts`、`extract.ts`、`manager.ts`、`indexer.ts`、`prompt.ts`、`config.ts` 和 Core 导出入口。先支持 `shadow`：Staging 路径生成和校验 Candidate，但不修改正式目录；Legacy 路径仍是唯一正式写入者，用于比较结果。确认稳定后再启用 `review/auto-private`。

#### 验证

- Staging 路径自身不修改正式 Memory；Shadow 期间只有 Legacy 路径可以写正式目录。
- Agent 无法写出 staging。
- 并发修改导致 conflict，不会覆盖。
- Reject 不修改正式目录。
- Apply 后才更新正式文件和索引。
- Team 永远需要确认。
- staging finalization 和 apply 都做秘密扫描。
- Shadow 模式不改变用户可见行为，并能比较旧写入和 Candidate 结果。

### PR 2.2c：Memory Inbox UI

建议提交：

```text
feat(cli): add auto-memory inbox review
```

#### 交互策略

- Extraction 后不自动弹出阻塞式 Dialog。
- `review` 模式显示非阻塞 Badge，每个 Session 最多提醒一次；用户通过 `/memory inbox` 或 Memory 面板主动打开。
- `auto-private` 下成功应用的私人 Candidate 不提醒；Team、Conflict 和 Invalid Candidate 进入 Inbox。
- 按 Extraction Task/Session 分组，默认每页 20 条；Conflict、Team 和高风险项优先，其余按时间倒序。
- Private Candidate 支持批量 Accept/Reject；Team Candidate 必须逐条确认。
- Inbox 展示作用域、类型、来源、置信度、时间和 Before/After Diff，支持 Accept、Reject、Edit 和 Conflict 处理。
- 达到 100 条/50 MiB 上限时显示持久告警和清理入口，不通过折叠掩盖积压。

#### 文件

新增 `MemoryInboxDialog.tsx` 和对应测试。修改 `MemoryDialog.tsx`、`DialogManager.tsx`、`AppContainer.tsx`、`UIStateContext.tsx`、`UIActionsContext.tsx`、`memoryCommand.ts` 和 `settingsSchema.ts`。

#### 验证

- Extraction 完成不会中断当前输入或自动打开 Dialog。
- Badge 每 Session 最多提醒一次，重启后 Pending 数量正确。
- 分页、分组、优先级和批量私人操作正确。
- Team 不能批量 Accept，Conflict 不能绕过 Digest 检查。
- 达到积压上限时告警清晰，拒绝或接受后容量实时释放。

### PR 2.3：延迟提取和任务级控制

建议提交：

```text
feat(memory): gate auto extraction by session eligibility
```

#### 设计

自动提取资格：至少 3 条非空用户消息、空闲至少 5 分钟或会话正常结束、不是 Subagent/Side Query、不在 safe/bare/incognito、外部上下文策略允许、没有处理过同一消息边界。

开启 Incognito 时取消当前 Session 未完成的 Extraction；期间消息不计入三条消息门槛，也不持久化由这些消息产生的 Cursor 或 Extraction State。关闭后不回溯处理 Incognito 消息。它只影响后续 Recall/Contribution，已经注入当前模型历史的 Memory 无法移除；严格隔离需要新建 Session。

`/remember` 继续立即执行。退出时不强制启动 Agent；下一次启动扫描符合条件但未处理的会话。

外部上下文策略：

```ts
type ExternalContextContributionPolicy = 'never' | 'review' | 'allow';
```

默认 `never`。Web、MCP、Tool Search、浏览器和外部文档任务默认不贡献。工具输出最高只能是 inferred，不能冒充用户确认。

任务级命令：

```text
/memory session use on|off
/memory session contribute on|off
/memory session incognito on|off
```

#### 涉及文件

新增 `extraction-eligibility.ts`、`extraction-state.ts` 及对应测试。修改 `client.ts`、`manager.ts`、`extract.ts`、Core/CLI Config、Settings Schema、VSCode Schema、Desktop Settings 类型、`memoryCommand.ts`、`MemoryDialog.tsx` 和用户文档。

#### 验证

- 短会话和活跃会话不提取。
- 空闲会话只生成一次 Candidate。
- 中断会话下次启动可恢复处理。
- 外部上下文默认不贡献。
- `/remember` 不受自动资格限制，但仍受秘密扫描。
- Incognito 不读不写。

---

## Phase 3：检索质量和生命周期

### PR 3.1：全量 Catalog、BM25 和模型重排

建议提交：

```text
feat(memory): add hybrid lexical and model retrieval
```

#### 设计

构建全量 Catalog，使用 Phase 1 Unicode Tokenizer 和字段加权 BM25，过滤 expired/superseded，应用 confidence/scope/轻量 freshness加权。BM25 与 Model Recall 并发；Model 在首轮预算内返回时优先使用其结果，否则只注入高置信 BM25 结果，最多 2 条。BM25 Top 20 可交给模型重排补充，最终总计不超过 5 条，不为填满配额注入弱相关文档。

建议权重：Title 4.0、Description 3.0、Summary 2.0、Why/How 1.0、Type/Scope 0.5。

上述权重只是评估起点。建立 50–100 组、目标不少于 100 组的多语言 `query → relevant memory` 标注集，保留独立验证集，使用 Recall@5、MRR@5、nDCG@5、irrelevant@5 和延迟比较 Legacy、bigram、BM25、BM25 + Rerank。权重先作为代码常量，只有数据证明收益后调整，避免在小样本上过拟合。

Topic 扫描上限从“Recall 前截断 200”改为“Catalog 最多 5000”；`MEMORY.md` 仍保持 200 行、25KB。超过 Catalog 上限必须告警，不能静默遗漏。

Recall 次数和时间存储在独立 Usage Store，避免每次召回修改 Markdown mtime 或产生 Team Git churn。

#### 涉及文件

新增：

```text
packages/core/src/memory/bm25.ts
packages/core/src/memory/bm25.test.ts
packages/core/src/memory/retrieval-index.ts
packages/core/src/memory/retrieval-index.test.ts
packages/core/src/memory/memory-usage-store.ts
packages/core/src/memory/memory-usage-store.test.ts
packages/core/src/memory/retrieval-eval.test.ts
packages/core/src/memory/testdata/retrieval-eval.json
```

修改 `scan.ts`、`indexer.ts`、`recall.ts`、`relevanceSelector.ts`、`manager.ts`、`candidates.ts`、`remember.ts`、`forget.ts` 和 `dream.ts`。

支持 `legacy | shadow | hybrid` 三种 Retrieval Mode。Shadow 运行新算法但注入旧结果，只记录数量、Top-K overlap 和耗时，不记录文档身份。

默认保持 `legacy`。只有标注集 Recall@5/MRR 不退化、无关结果率达标、首轮延迟满足预算，且线上投递/纠正指标无回归时才切换 `hybrid`；`fast 2 + refined 3` 始终只是上限。

#### 验证

- 建立中英文、冲突、过期、同名跨作用域、工单号、URL 和 200/1000/5000 文档 Fixture。
- Recall@5 大于 90%。
- 明显无关结果低于 5%。
- CJK 与英文差距低于 10%。
- 1000 文档 Fast Query P95 小于 50ms。
- Catalog Build P95 小于 500ms。

### PR 3.2：多作用域 Consolidation、过期和冲突

建议提交：

```text
feat(memory): consolidate user project and team scopes
```

#### 设计

Project 默认 24 小时/5 个新会话；User 默认 7 天/20 个新会话；Team 不自动应用，只生成 Candidate。

Dream 使用与 Extraction 相同的 snapshot → isolated clone → diff → candidate 流程，不再直接删除或覆盖正式 Memory。

`expires_at < now` 时标记 expired，普通 Recall 不再选中，但不立即删除。冲突推荐优先级为：经工具或文件验证的当前观测 > QWEN/AGENTS > Project explicit/asserted > User explicit/asserted > Project inferred > User inferred > expired/superseded。模型对用户意图的解释不属于“当前观测”。

该优先级只决定推荐处理方式，不授予静默覆盖权限。`last_verified_at` 仅作为同级证据的 Tie-breaker；新 inferred 永远不能自动 supersede explicit/asserted，而是生成 Conflict Candidate。新的已验证 explicit 事实可以在评审或明确证据下 supersede 旧事实。旧 Memory 保留并标记 superseded。

#### 涉及文件

新增：

```text
packages/core/src/memory/consolidation-policy.ts
packages/core/src/memory/consolidation-policy.test.ts
packages/core/src/memory/memory-conflicts.ts
packages/core/src/memory/memory-conflicts.test.ts
```

修改 `dream.ts`、`dreamAgentPlanner.ts`、`manager.ts`、`types.ts`、`paths.ts`、`candidates.ts`、`recall.ts`、`indexer.ts`、`dreamCommand.ts` 和 `MemoryInboxDialog.tsx`。

#### 验证

- 三种作用域严格隔离。
- Team Consolidation 永远不直接应用。
- expired/superseded 保留存储但退出普通 Recall。
- 指令和 Memory 冲突时指令优先。
- Digest 冲突时 Candidate 不应用。
- 多进程 Lock 和取消清理正常。

### PR 3.3：模型、预算、路由和项目身份

建议提交：

```text
feat(memory): add routing budgets and project identity controls
```

#### 设计

支持独立配置 extraction、recall、consolidation 模型和每日 Side Query Token Budget。预算耗尽后，本地 BM25 继续工作，自动 Extraction 延迟，自动 Dream 跳过，显式 `/remember` 保留。

持久知识路由为：

```ts
type DurableKnowledgeTarget = 'instruction' | 'memory' | 'skill' | 'ignore';
```

团队长期规则进入 Instruction Candidate；用户偏好和项目背景进入 Memory Candidate；可复用流程进入 Skill Candidate；临时任务状态忽略。任何路由都不能让 Extraction 直接写 QWEN/AGENTS 或 Skill Library。

项目身份支持 `worktree | repository`，默认继续 worktree。Repository 模式跨 linked worktree 共享私人 Project Memory，但 Team Memory 仍留在当前 worktree 以便 Git Diff。切换身份不自动移动或删除旧目录。

#### 涉及文件

新增 `memory-routing.ts` 和测试。修改 `paths.ts`、Core Config、CLI Settings Schema、`MemoryDialog.tsx`、VSCode Schema、Desktop Settings 类型、Extraction/Skill Planner 和相关 Review Dialog。

#### 验证

- Side Query 使用独立模型但不改变主 Session 模型。
- 预算耗尽后本地 Recall 和显式 Remember 仍可用。
- 四类路由对 Fixture 有确定结果。
- 不发生直接 Instruction/Skill 写入。
- Worktree 默认行为不变。
- Repository 模式正确共享私人 Project Memory。
- 切换身份不删除旧数据。

---

## 完整验证和发布策略

### 测试层级

1. 每个新增生产文件都有同目录 Vitest。
2. `memoryLifecycle.integration.test.ts` 覆盖 conversation → eligibility → staging → candidate → apply → recall → consolidation。
3. Phase 级 E2E 覆盖多语言召回、模型挂起、Forget、秘密扫描、Review、外部 Context、Incognito、v1 兼容、大规模检索和作用域隔离。
4. 故障注入覆盖 Agent timeout、无工具调用、坏 manifest、并发修改、ENOSPC、EACCES、符号链接、Git 分叉、Recall 模型挂起、Shutdown 和内存压力。
5. 基准覆盖 10、100、1000、5000 文档的冷/热启动和多语言 Query。

每个 PR 执行目标测试及：

```bash
npm run build
npm run typecheck
npm run lint
```

每个阶段完成后执行：

```bash
npm run preflight
```

### 发布顺序

1. 先发布 Phase 1，不涉及格式迁移。
2. 先发布 Schema v2 Reader，再启用 v2 Writer。
3. 先发布不改变行为的 Candidate Staging 基础设施。
4. Extraction 接入 Staging 后先以 Shadow 比较，Staging 不写正式目录。
5. 发布非阻塞 Inbox 后再开放 `review` 策略。
6. 现有开启 Auto Memory 的安装保持 `auto-private` 兼容行为。
7. Hybrid Retrieval 先 Shadow 并达到质量门槛，再切正式注入。
8. Project 和 User Consolidation 分别开启。
9. Team Consolidation 始终只生成 Candidate。

### 回滚

- 两阶段 Recall 可回退 Legacy，不影响存储。
- v2 的 type/name/description/body 仍可被旧 Reader 使用。
- Candidate Pipeline 可停止生成，Pending 目录不会进入 Recall。
- Hybrid 可切 `retrievalMode=legacy`。
- User/Team Consolidation 可分别关闭。
- Project Identity 可切回 worktree；旧目录不删除。
- 任何阶段都不自动删除旧目录或批量重写所有 Memory。

### 最终指标

| 指标                    |      目标 |
| ----------------------- | --------: |
| Recall 未消费率         |    `< 1%` |
| Recall@5                |   `> 90%` |
| CJK 与英文 Recall 差距  |   `< 10%` |
| 明显无关 Recall 比例    |    `< 5%` |
| 首轮附加 P95            | `< 200ms` |
| Candidate Schema 失败率 |    `< 1%` |
| Auto-private 冲突率     |    `< 1%` |
| 确认后候选漂移          |       `0` |
| 新秘密进入正式 Memory   |       `0` |
| Team 未评审写入         |       `0` |
| v1 兼容读取             |    `100%` |
| 自动操作可观测率        |    `100%` |

</details>

## 1. Summary

This document defines a three-phase evolution of Qwen Code's managed auto
memory system. The roadmap keeps Markdown as the durable storage format while
improving recall reliability, write safety, provenance, reviewability,
retrieval quality, and lifecycle management.

The work is intentionally split into twelve small, independently reviewable
changes:

| Phase   | Goal                                    | PRs | Result                                                                 |
| ------- | --------------------------------------- | --: | ---------------------------------------------------------------------- |
| Phase 1 | Reliability, safety, and observability  |   4 | Reliable first-turn recall, CJK fallback, secret scanning, safe forget |
| Phase 2 | Trustworthy writes and human governance |   5 | Schema v2, candidate staging, integration, inbox, deferred extraction  |
| Phase 3 | Retrieval quality and lifecycle         |   3 | BM25 and reranking, scoped consolidation, conflicts, expiry, budgets   |

The target pipeline is:

```mermaid
flowchart LR
    A["Conversation or explicit remember"] --> B["Candidate extraction"]
    B --> C["Schema, provenance, and secret validation"]
    C --> D["Scope and type routing"]
    D --> E{"Write policy"}
    E -->|Low-risk private write| F["Durable Markdown memory"]
    E -->|Review required| G["Memory Inbox"]
    G -->|Accept or edit| F
    G -->|Reject| H["Audit outcome"]
    F --> I["Full memory catalog"]
    I --> J["Unicode and BM25 fast recall"]
    J --> K["Model reranking"]
    K --> L["Inject at most five documents"]
    F --> M["Scope-aware consolidation"]
    M --> G
```

## 2. Design invariants

Every phase must preserve these invariants:

1. Durable memory remains human-readable Markdown.
2. `MEMORY.md` is framework-generated; agents do not maintain it manually.
3. Background memory failures never block the user's main request.
4. A logical turn injects at most five memory documents.
5. A late recall result is never reused directly for a different query.
6. Secret values never enter errors, logs, telemetry, or review metadata.
7. Team memory creation and consolidation remain reviewable.
8. Existing memory files are not destructively migrated in bulk.
9. Automatic overwrite and delete operations perform conflict checks.
10. Recall, extraction, application, and consolidation are measurable.

## 3. Current architecture and constraints

The current implementation provides:

- User, project, and optional Git-shared team scopes.
- Four memory types: `user`, `feedback`, `project`, and `reference`.
- Background extraction after user turns.
- Model-driven recall with a heuristic error fallback.
- Project-only Dream consolidation.
- Explicit `/remember`, `/forget`, and `/dream` commands.
- Per-project task coordination, cursors, locks, memory-pressure gates, and
  cancellation.

Important existing boundaries:

- Recall scans project and user topic documents; team topic documents are
  reached through the always-loaded team index rather than query-time recall.
- The model selector sees headers and descriptions, not full bodies.
- The heuristic tokenizer currently only recognizes ASCII alphanumeric tokens.
- Extraction and Dream agents write directly into live memory directories.
- The team scope has secret scanning; private scopes do not.
- `/forget` applies model-selected deletions without a confirmation step.
- Topic scanning is capped at 200 files before retrieval.

The design below changes these boundaries incrementally rather than replacing
the entire subsystem.

## 3.1 Competitive baseline as of 2026-07-16

This comparison covers durable knowledge across sessions. Conversation resume,
context compaction, instruction files, and skills are related context surfaces,
but are not counted as auto memory by themselves. Product behavior changes
quickly; the baseline uses the current repository and these official sources:

- [Claude Code: How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Codex: Memories](https://learn.chatgpt.com/docs/customization/memories)
- [Gemini CLI: Memory files](https://geminicli.com/docs/tools/memory/)
- [Gemini CLI: Configuration reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md#experimental)

### 3.1.1 Capability snapshot

| Dimension                       | Current Qwen Code                                                                                           | Claude Code                                                                                         | Codex CLI                                                                                                                  | Gemini CLI                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Durable guidance and learning   | QWEN/AGENTS guidance plus managed memory; explicit `/remember` and background extraction                    | Separates `CLAUDE.md` from auto memory; auto memory is on by default and records selected learnings | Separates `AGENTS.md` from local memories; local memories are off by default                                               | Hierarchical `GEMINI.md`; direct save support, with background auto memory still experimental and off by default        |
| Storage and scope               | Markdown with user, project, and optional Git-shared team scopes                                            | One machine-local directory per repository, shared across worktrees; `MEMORY.md` plus topic files   | Generated local state under `~/.codex/memories/`, including summaries, durable entries, recent inputs, and evidence        | Global, private-project, and repository-shared Markdown tiers                                                           |
| Capture timing                  | Background extraction after user turns; periodic project Dream                                              | Claude reads and writes during work and does not promise a write every session                      | Skips active or short tasks, waits for idle time, and can gate generation on remaining rate limit                          | Direct `save_memory`/file writes; experimental auto memory extracts patches from past sessions in the background        |
| Recall                          | Model-primary with ASCII heuristic fallback; topic scan truncates at 200 before selection                   | Loads the first 200 lines or 25 KB of `MEMORY.md`; reads topic files on demand                      | Injects relevant local memory into future tasks; public docs do not promise a ranking algorithm                            | Automatically includes stored facts in hierarchical context; public docs do not promise a separate relevance ranker     |
| Write governance                | Extraction and Dream agents directly mutate live memory; team scope has additional restrictions             | Direct local Markdown writes; `/memory` supports browse, edit, delete, and disable                  | Generated files are inspectable and task-level use/contribute controls exist; no pre-write inbox is publicly documented    | Experimental auto memory writes unified-diff patches to `/memory inbox`; nothing applies before approval                |
| Provenance, conflict, lifecycle | No stable ID, unified provenance, expiry, or supersession semantics; project-only Dream                     | Public docs do not describe structured provenance, conflict, or expiry schema                       | Stores supporting evidence and has extraction/global consolidation; no user-visible conflict schema is publicly documented | Routes across tiers and avoids duplication; patches are reviewable, but no unified expiry schema is publicly documented |
| Security and privacy            | Secret guard currently covers only team memory; external-context and task-incognito controls are incomplete | Plain Markdown is auditable; the official memory page does not promise a secret scanner             | Redacts secrets from generated fields and can exclude external-context tasks from contribution                             | Plain Markdown is auditable; the official memory page does not promise a secret scanner                                 |
| User controls                   | `/remember`, `/forget`, and `/dream`; forget currently lacks confirmation and operation governance          | `/memory` opens files and the directory and toggles auto memory                                     | `/memories` independently controls task-level use and contribution                                                         | `/memory show/add/refresh`; experimental `/memory inbox` reviews patches                                                |

“Not publicly documented” means the official material does not establish the
capability; it is not proof that an internal implementation lacks it.

### 3.1.2 Current position and gaps

Qwen Code's current advantage is its scope model: user, project, team,
explicit remember/forget, project Dream, and Git-shared team memory already form
a useful governance foundation. It is closer to a team knowledge system than a
single project scratchpad.

The priority gaps are:

1. **Write trust trails Gemini CLI's experimental path.** Agents still mutate
   live memory without patch isolation, review-before-apply, digest conflict
   checks, or staging GC.
2. **Capture eligibility trails Codex CLI.** Per-turn extraction can process
   short or active work and lacks idle, completed-session, rate-limit,
   external-context, and task-contribution gates.
3. **Recall reliability and multilingual support are weak.** Model-primary
   output may miss the consuming turn, ASCII heuristics underperform on CJK,
   and pre-retrieval truncation at 200 creates systematic misses.
4. **Audit UX trails Claude Code.** Markdown is available, but there is no
   single inbox/browser that explains what was written, why, when it was used,
   and how to reject it.
5. **Safety is inconsistent across scopes.** Private writes lack the team
   secret guard, and forget lacks stable preview, confirmation, and
   process-local undo.
6. **Knowledge lifecycle is incomplete.** Stable IDs, provenance, confidence,
   expiry, supersession, cross-scope conflicts, and retrieval evaluation are
   absent.

### 3.1.3 Target position after this roadmap

The target combines proven properties rather than copying one competitor:

- Preserve Claude Code's auditable plain Markdown, compact index, and on-demand
  topic pattern.
- Adopt Codex CLI's deferred eligibility, task-level use/contribution,
  external-context gating, secret redaction, and separate extraction and
  consolidation controls.
- Adopt Gemini CLI's experimental staged-patch and inbox-before-apply pattern,
  then add digest checks, GC, and mandatory team review.
- Extend the public baseline with schema-v2 provenance, all-scope secret guards,
  BM25 plus model shadow evaluation, expiry/supersession, and recall-delivery
  telemetry.

Phase 1 must first demonstrate reliable delivery, safe deletion, and zero new
secrets in every scope. Phase 2 must demonstrate isolated, reviewable, and
conflict-safe writes. Phase 3 must establish retrieval quality with annotated
offline evaluation and online telemetry rather than claim superiority from a
feature checklist alone.

---

# Phase 1: Reliability, safety, and observability

## 4. PR 1.1: Recall delivery telemetry

Suggested commit:

```text
chore(memory): add recall delivery telemetry
```

### 4.1 Objective

Distinguish memory selection from actual prompt delivery. The system must show
whether selected memory was injected on the initial request, injected on a tool
continuation, or discarded.

### 4.2 Event model

Add a `qwen-code.memory.recall_delivery` event:

```ts
type RecallPhase = 'fast' | 'refined';

type RecallDeliveryPoint = 'initial' | 'tool_result' | 'discarded';

type RecallDiscardReason =
  | 'turn_completed_without_tool'
  | 'replaced_by_new_query'
  | 'user_abort'
  | 'reset_chat'
  | 'loop_detected'
  | 'session_limit'
  | 'shutdown'
  | 'error';

interface MemoryRecallDeliveryEvent {
  phase: RecallPhase;
  delivery_point: RecallDeliveryPoint;
  discard_reason?: RecallDiscardReason;
  strategy: 'none' | 'heuristic' | 'model';
  docs_selected: number;
  age_ms: number;
}
```

`loop_detected` is emitted only when the existing `LoopDetector` terminates the
current logical turn. Repeated output that does not trigger that safeguard,
user cancellation, and timeouts use their own reasons.

Do not record query text, memory content, file paths, model reasoning, or session
identifiers.

### 4.3 File changes

| File                                                 | Change                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/core/src/telemetry/constants.ts`           | Add event and metric constants.                                     |
| `packages/core/src/telemetry/types.ts`               | Add `MemoryRecallDeliveryEvent`; add recall phase.                  |
| `packages/core/src/telemetry/loggers.ts`             | Add `logMemoryRecallDelivery`.                                      |
| `packages/core/src/telemetry/metrics.ts`             | Add low-cardinality delivery counters and latency histogram.        |
| `packages/core/src/telemetry/index.ts`               | Export the new event and logger.                                    |
| `packages/core/src/core/client.ts`                   | Give every recall cancellation an explicit reason and log delivery. |
| `packages/core/src/memory/extractionAgentPlanner.ts` | Return written/touched file counts.                                 |
| `packages/core/src/memory/extract.ts`                | Propagate real file counts.                                         |
| `packages/core/src/memory/manager.ts`                | Stop treating touched topic count as patch count.                   |

Keep the old `patches_count` and `deduped_entries` fields temporarily for
dashboard compatibility. Add:

```ts
files_written_count: number;
files_touched_count: number;
touched_topics_count: number;
deduped_entries_known: boolean;
```

### 4.4 Verification

Run:

```bash
cd packages/core
npx vitest run src/telemetry/loggers.test.ts
npx vitest run src/telemetry/metrics.test.ts
npx vitest run src/memory/extractionAgentPlanner.test.ts
npx vitest run src/memory/extract.test.ts
npx vitest run src/memory/manager.test.ts
npx vitest run src/core/client.test.ts
```

Acceptance criteria:

- Every recall cancellation path reports a bounded discard reason.
- Telemetry never contains queries, content, paths, or secret values.
- File count fields match the agent's actual file lists.
- Every completed selection has a corresponding delivery or discard outcome.

## 5. PR 1.2: Fast recall and CJK retrieval

Suggested commit:

```text
fix(memory): guarantee fast recall on the initial turn
```

### 5.1 Two-phase recall with a guarded rollout

Introduce:

```ts
interface AutoMemoryRecallPlan {
  initial: Promise<RelevantAutoMemoryPromptResult>;
  refined: Promise<RelevantAutoMemoryPromptResult>;
}
```

This change must not immediately replace the current model-primary path with a
heuristic-primary default. The lifecycle becomes:

1. Scan project and user memory once.
2. Start deterministic local recall and the existing model recall concurrently.
3. Prefer the model result if it settles within the initial-turn budget.
4. Otherwise inject only high-confidence local matches, at most two; do not
   inject weak matches merely to fill the allocation.
5. Continue the model recall asynchronously as refinement.
6. Inject at most three additional documents on the first tool-result turn.
7. If no tool continuation occurs, discard refinement with telemetry.
8. Never carry a refinement result into a different user query.

The `fast 2 + refined 3` split is a capacity limit, not a fixed quota. Fast
recall may return zero, and the total never exceeds five.

### 5.2 Tokenization

Normalize with Unicode NFKC, lowercase Latin text, preserve ASCII tokens of at
least three characters, and generate overlapping two-character grams for Han,
Hiragana, Katakana, and Hangul runs.

```ts
const ASCII_TOKEN = /[a-z0-9]{3,}/gu;
const CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
```

Single CJK characters do not participate in broad fallback recall. Iterate by
Unicode code point rather than UTF-16 index.

Two-character grams are a low-cost Phase 1 fallback, not the final CJK
tokenization strategy. Phase 3 compares bigrams, `Intl.Segmenter`, and
language-specific tokenizers on multilingual relevance, latency, index size,
and bundle cost. Add a dependency only when the measured gain justifies it.

### 5.3 Scoring correction

Non-empty bodies must not receive an unconditional relevance point. Require a
lexical match before applying type or scope boosts:

```ts
if (lexicalScore === 0) return 0;
return lexicalScore + typeBoost;
```

### 5.4 File changes

| File                                                           | Change                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/core/src/memory/recall.ts`                           | Add recall plan, shared scan, Unicode tokenizer, and corrected scoring. |
| `packages/core/src/memory/relevanceSelector.ts`                | Accept remaining result budget and excluded paths.                      |
| `packages/core/src/memory/manager.ts`                          | Expose `createRecallPlan`.                                              |
| `packages/core/src/core/client.ts`                             | Await fast recall, retain only refined prefetch, and record delivery.   |
| `packages/core/src/memory/recall.test.ts`                      | Add CJK, mixed-language, and scoring cases.                             |
| `packages/core/src/memory/relevanceSelector.test.ts`           | Test result budget and exclusion.                                       |
| `packages/core/src/core/client.test.ts`                        | Test initial/refined lifecycle and cancellation.                        |
| `packages/core/src/memory/memoryLifecycle.integration.test.ts` | Exercise the complete two-phase lifecycle.                              |

### 5.5 Failure behavior

- Project scan failure yields empty recall but does not block the main request.
- User scan failure preserves project recall.
- Fast failure does not prevent model refinement.
- Model failure does not affect already-injected fast memory.
- A model-selected empty set is valid; a high-confidence fast result may have
  provided an initial fallback.

### 5.6 Verification

Required cases:

- Model recall never settles, but a high-confidence relevant Chinese memory
  reaches the initial prompt.
- A no-tool response uses fast memory and discards refined memory.
- Fast selects zero to two and refined fills the total to at most five.
- The same path is not injected twice.
- Chinese, Japanese, Korean, English, and mixed queries behave deterministically.
- Single-character CJK queries do not recall broad unrelated sets.
- A new query cancels the old refined result.
- Disabling managed memory prevents both phases.
- An internal rollout flag keeps model-primary behavior while comparing the two
  result sets. Hybrid is enabled only after Recall@5, MRR, irrelevant-result
  rate, delivery telemetry, and online correction signals show no regression.
  The public `retrievalMode` setting is introduced in Phase 3.

Performance gates:

| Metric                     |                Target |
| -------------------------- | --------------------: |
| Fast recall P95            |            `< 100 ms` |
| Initial-turn added P95     |            `< 150 ms` |
| Total injected documents   |                `<= 5` |
| Injected body per document | `<= 1,200 characters` |

## 6. PR 1.3: Secret scanning for all managed scopes

Suggested commit:

```text
fix(memory): block secrets in all managed memory scopes
```

### 6.1 Scope-aware guard

Rename `team-memory-secret-guard.ts` to
`managed-memory-secret-guard.ts` and expose:

```ts
type ManagedMemoryScope = 'project' | 'user' | 'team';

interface ManagedMemorySecretViolation {
  scope: ManagedMemoryScope;
  ruleIds: string[];
  message: string;
}
```

Add a realpath-aware `getManagedMemoryScope` helper. Scope detection must handle
new files, symlinked parents, path traversal, and path-prefix collisions.

### 6.2 File changes

| File                                                   | Change                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `packages/core/src/memory/paths.ts`                    | Add safe scope detection.                                     |
| `packages/core/src/memory/team-memory-secret-guard.ts` | Rename and generalize to all scopes.                          |
| `packages/core/src/tools/write-file.ts`                | Scan managed-memory writes in validation and execution.       |
| `packages/core/src/tools/edit.ts`                      | Scan the complete resulting file in validation and execution. |
| `docs/users/features/memory.md`                        | Document the expanded guard and its limitations.              |

Add:

```text
packages/core/src/memory/managed-memory-secret-guard.test.ts
packages/core/src/memory/managed-memory-paths.test.ts
```

Extend `write-file.test.ts` and `edit.test.ts`.

### 6.3 Scope boundary

The guarantee applies to framework-managed `write_file` and `edit` operations,
including extraction, remember, and Dream agents. It does not claim to intercept
an external process or a user-authored shell redirection.

Existing stored secrets are not automatically removed. Historical auditing is
a separate operation because deletion may be destructive and may not remediate
the original source or Git history.

New managed-memory documents are limited to 64 KiB and rejected before a scan
when larger. Existing oversized documents remain readable but must be reduced
before another write. Benchmark 64 KiB and 1 MiB inputs to verify that the
curated, bounded scanner remains linear and does not slow ordinary edits.

### 6.4 Verification

- Project, user, and team writes containing credentials are rejected.
- Multiple individually safe edit fragments that form a credential are rejected
  after composition.
- A pre-existing secret must be removed before an unrelated edit can succeed.
- Errors and telemetry contain rule labels, never matched values.
- Ordinary source files are unaffected by the memory-specific guard.
- Symlink and path traversal cases cannot bypass detection.

## 7. PR 1.4: Confirmed and undoable forget

Suggested commit:

```text
fix(memory): confirm and undo forget operations
```

### 7.1 Confirmation

The first `/forget <query>` invocation selects and displays candidate entries
but performs no mutation. It returns the existing `confirm_action` result. The
confirmed invocation must use the exact selection the user saw rather than run
model selection again.

Maintain a bounded pending-selection map keyed by project root and raw command:

- Maximum 20 entries.
- Five-minute TTL.
- Project root must still match at confirmation.
- Missing or expired state requires a new preview.
- Successful deletion removes the pending selection.

### 7.2 Process-local undo

Keep at most ten undo records for 30 minutes in `MemoryManager`. Do not write
deleted content to a persistent trash directory.

The confirmation and completion messages state that undo is available only in
the current process. Persistent JSON or `.trash` storage is intentionally not a
default because it retains content the user explicitly asked to forget,
including possible secrets and personal data. Crash-safe undo requires a
separate, default-off privacy design with a short TTL, restricted permissions,
and an explicit permanent-delete path.

```ts
interface AutoMemoryForgetUndoRecord {
  id: string;
  projectRoot: string;
  createdAt: number;
  snapshots: Array<{
    scope: 'user' | 'project';
    filePath: string;
    beforeContent: string | null;
    expectedAfterHash: string | null;
  }>;
}
```

`/forget --undo [operation-id]` performs a full conflict preflight. If any
current file differs from its expected post-delete state, restore nothing.

### 7.3 File changes

| File                                                       | Change                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/core/src/memory/forget.ts`                       | Snapshot, hash, restore, and conflict preflight.           |
| `packages/core/src/memory/manager.ts`                      | Bounded undo registry and `undoForget`.                    |
| `packages/cli/src/ui/commands/forgetCommand.ts`            | Preview, confirmation cache, and `--undo`.                 |
| `packages/core/src/memory/forget.test.ts`                  | Delete, restore, conflict, and cross-scope cases.          |
| `packages/core/src/memory/manager.test.ts`                 | Registry TTL, limit, and project isolation.                |
| `packages/cli/src/ui/commands/forgetCommand.test.ts`       | No mutation before confirmation and exact candidate reuse. |
| `packages/cli/src/ui/hooks/slashCommandProcessor.test.ts`  | Confirmed command replay.                                  |
| `packages/cli/src/acp-integration/session/Session.test.ts` | ACP cannot bypass confirmation.                            |

Do not add a `--yes` bypass in this phase.

---

# Phase 2: Trustworthy writes and human governance

## 8. PR 2.1: Provenance-aware memory schema v2

Suggested commit:

```text
feat(memory): add provenance-aware memory schema v2
```

### 8.1 Document format

Continue storing one durable memory per Markdown file:

```yaml
---
version: 2
id: mem_550e8400-e29b-41d4-a716-446655440000
type: project
scope: project
name: Release merge freeze
description: Non-critical merges are frozen during the mobile release.
confidence: asserted
status: active
created_at: 2026-07-16T10:00:00.000Z
updated_at: 2026-07-16T10:00:00.000Z
last_verified_at: 2026-07-16T10:00:00.000Z
source_kind: user_message
context_origin: local
---

Non-critical merges are frozen after 2026-07-18.

Why: The mobile team is cutting a release branch.

How to apply: Flag non-critical merge work scheduled after the freeze.
```

Enums:

```ts
type MemoryConfidence = 'explicit' | 'asserted' | 'inferred';
type MemoryStatus = 'active' | 'superseded' | 'expired';
type MemorySourceKind =
  | 'explicit_remember'
  | 'user_message'
  | 'assistant_inference'
  | 'tool_output'
  | 'migration'
  | 'team_review';

type MemoryContextOrigin = 'local' | 'external' | 'mixed';
```

Generate IDs as `mem_${crypto.randomUUID()}` and candidate IDs as
`cand_${crypto.randomUUID()}`. This avoids a new ULID dependency; chronological
sorting uses explicit timestamps.

Omit optional fields such as `expires_at`, `supersedes`, and
`last_verified_at` when they have no value. `source_kind` identifies who or
what asserted the fact, while the orthogonal `context_origin` identifies
whether evidence depended on external context. Store verbose private
`source_session_id` and `source_message_ids` in a private sidecar keyed by
memory ID rather than durable frontmatter. Team documents remove those private
identifiers when accepted, use `source_kind: team_review`, and may later record
Git attribution.

Tool-derived evidence uses `source_kind: tool_output`; the removed
`external_context` source kind no longer overlaps with `context_origin`.

### 8.2 Compatibility

- Missing version means v1.
- A v1 document maps in memory to inferred, active, migration-sourced metadata.
- Reading v1 does not rewrite it.
- Updating a v1 document writes a valid v2 document.
- Unknown v2 fields do not break older type/name/description/body readers.
- No startup-wide migration is performed.

### 8.3 File changes

Add:

```text
packages/core/src/memory/memory-document.ts
packages/core/src/memory/memory-document.test.ts
packages/core/src/memory/memory-provenance-store.ts
packages/core/src/memory/memory-provenance-store.test.ts
```

Modify:

| File                                                 | Change                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/core/src/memory/types.ts`                  | Add v2 types and version constants.                              |
| `packages/core/src/memory/entries.ts`                | Keep body parsing separate from metadata.                        |
| `packages/core/src/memory/scan.ts`                   | Use the centralized document parser.                             |
| `packages/core/src/memory/indexer.ts`                | Index active documents and carry confidence/status hooks.        |
| `packages/core/src/memory/prompt.ts`                 | Explain v2 metadata and confidence rules.                        |
| `packages/core/src/memory/extractionAgentPlanner.ts` | Supply source context without allowing fake explicit confidence. |
| `packages/core/src/memory/remember.ts`               | Write explicit confidence.                                       |
| `packages/core/src/memory/forget.ts`                 | Prefer stable memory IDs.                                        |
| `packages/core/src/memory/dreamAgentPlanner.ts`      | Maintain verification and supersession fields.                   |
| `packages/core/src/memory/store.ts`                  | Update scaffolding.                                              |

### 8.4 Verification

- Parse and render v1 and v2 fixtures.
- Reading v1 does not change bytes.
- Updating v1 creates valid v2.
- Invalid enum values isolate one document rather than fail the full scan.
- Team serialization strips private provenance.
- Empty optional values are not serialized.
- CRLF, Unicode, YAML quoting, and arrays round-trip.

## 9. PR 2.2a: Candidate staging infrastructure

Suggested commit:

```text
feat(memory): add auto-memory candidate staging
```

### 9.1 Scope

Add pure Core infrastructure without connecting it to the current extraction
path or adding UI:

1. Snapshot user and project memory.
2. Copy the snapshot into a task staging directory.
3. Diff the proposed tree against the snapshot.
4. Convert each file change into a candidate.
5. Validate path, schema, provenance, and secrets.
6. Persist bounded candidate state and support garbage collection.

This PR has no user-visible behavior. The APIs remain unused outside tests so
the domain model, filesystem safety, and lifecycle can be reviewed separately.

Staging layout:

```text
~/.qwen/projects/<project>/memory-candidates/
  <task-id>/
    manifest.json
    original/
    proposed/
```

### 9.2 Candidate model and conflict invariant

```ts
interface MemoryCandidate {
  id: string;
  taskId: string;
  action: 'create' | 'update' | 'delete';
  scope: 'user' | 'project' | 'team';
  targetRelativePath: string;
  baseDigest: string | null;
  proposedContent: string | null;
  sourceSessionId?: string;
  createdAt: string;
  status: 'pending' | 'accepted' | 'rejected' | 'conflicted' | 'invalid';
  validationErrors: string[];
}
```

Application requires the current target digest to match `baseDigest`. A mismatch
marks the candidate conflicted and never overwrites the live file. Generate IDs
as `cand_${crypto.randomUUID()}`.

### 9.3 Staging lifecycle and garbage collection

- Immediately delete `original/` and `proposed/` content after acceptance or
  rejection; retain only a sanitized audit manifest for seven days.
- Remove orphaned `running` task directories after 24 hours.
- Quarantine a corrupt manifest, warn once, and retain it for at most seven
  days.
- Expire and remove pending candidates after 30 days.
- Allow at most 100 pending candidates or 50 MiB per project. At either limit,
  stop new automatic candidate generation and warn; never silently drop a
  pending candidate.
- Run best-effort GC on session startup and after candidate resolution. GC
  failure never blocks the main session.

### 9.4 File changes

Add:

```text
packages/core/src/memory/candidates.ts
packages/core/src/memory/candidates.test.ts
packages/core/src/memory/candidate-store.ts
packages/core/src/memory/candidate-store.test.ts
packages/core/src/memory/memory-snapshot.ts
packages/core/src/memory/memory-snapshot.test.ts
packages/core/src/memory/candidate-gc.ts
packages/core/src/memory/candidate-gc.test.ts
```

Modify `packages/core/src/memory/paths.ts` and the Core export entry point to
expose candidate APIs without activating them.

### 9.5 Verification

- Create, update, and delete diffs produce deterministic candidates.
- Staging paths cannot escape the project candidate root.
- Pending state survives restart; one corrupt manifest does not hide others.
- Resolved content, audit manifests, orphans, quarantine, and pending TTLs
  follow the lifecycle rules.
- The 100-candidate/50-MiB cap stops new tasks without deleting pending work.
- GC failure does not prevent session startup.

## 10. PR 2.2b: Route extraction through staging

Suggested commit:

```text
feat(memory): route extraction through candidate staging
```

### 10.1 Isolated extraction and application

Extraction and consolidation agents no longer edit live memory. Restrict an
agent to its staged copy, convert its diff to candidates, and update live files
and indexes only through framework application.

Application requires a successful schema, provenance, path, and secret check,
plus a matching `baseDigest`. A mismatch becomes a conflict.

### 10.2 Write policy

```ts
type MemoryWritePolicy = 'off' | 'review' | 'auto-private';
```

| Policy         | User/project                | Team                    |
| -------------- | --------------------------- | ----------------------- |
| `off`          | No candidate generation     | No candidate generation |
| `review`       | Inbox                       | Inbox                   |
| `auto-private` | Auto-apply after validation | Inbox                   |

Do not provide an unreviewed team-write mode. Existing
`enableManagedAutoMemory=false` maps to `off`; existing `true` with no new
setting maps to `auto-private`.

### 10.3 File changes

| File                                                     | Change                                        |
| -------------------------------------------------------- | --------------------------------------------- |
| `packages/core/src/memory/paths.ts`                      | Candidate and staging paths.                  |
| `packages/core/src/memory/memory-scoped-agent-config.ts` | Permit writes only inside staging.            |
| `packages/core/src/memory/extractionAgentPlanner.ts`     | Point the agent at the staged copy.           |
| `packages/core/src/memory/extract.ts`                    | Return candidate results.                     |
| `packages/core/src/memory/manager.ts`                    | List, accept, reject, and apply candidates.   |
| `packages/core/src/memory/indexer.ts`                    | Rebuild only after framework application.     |
| `packages/core/src/memory/prompt.ts`                     | Remove instructions for manual index editing. |
| `packages/core/src/config/config.ts`                     | Resolve write policy.                         |
| `packages/core/src/index.ts`                             | Export candidate APIs.                        |

### 10.4 Rollout and verification

- Start in `shadow`: the staging path generates and validates candidates but
  does not mutate live memory. The legacy path remains the only live writer so
  its result can be compared.
- The staging path itself never changes live memory.
- The scoped agent cannot write outside staging.
- Concurrent live edits create conflicts instead of overwrites.
- Rejection never changes live memory.
- Acceptance atomically updates one file and then its index.
- Team candidates always require review.
- Secrets are checked at staging finalization and application.

## 11. PR 2.2c: Memory Inbox UI

Suggested commit:

```text
feat(cli): add auto-memory inbox review
```

### 11.1 Interaction policy

- Extraction completion never opens a blocking dialog automatically.
- In `review` mode, show a non-blocking badge and at most one notification per
  session. Users open the inbox with `/memory inbox` or the Memory panel.
- In `auto-private`, do not notify for successfully applied private candidates;
  team, conflicted, and invalid candidates enter the inbox.
- Group by extraction task/session, show 20 items per page, prioritize
  conflicted, team, and high-risk items, then sort newest first.
- Allow batch accept/reject for private candidates. Team candidates require
  individual confirmation.
- Show scope, type, source, confidence, age, and a before/after diff. Support
  accept, reject, edit, and conflict handling.
- At the 100-candidate/50-MiB limit, show a persistent warning and cleanup
  entry point rather than hiding the backlog through visual folding.

### 11.2 File changes

Add `packages/cli/src/ui/components/MemoryInboxDialog.tsx` and its collocated
test. Modify:

| File                                                | Change                             |
| --------------------------------------------------- | ---------------------------------- |
| `packages/cli/src/ui/components/MemoryDialog.tsx`   | Show write policy and inbox count. |
| `packages/cli/src/ui/components/DialogManager.tsx`  | Register the inbox dialog.         |
| `packages/cli/src/ui/AppContainer.tsx`              | Subscribe to candidate state.      |
| `packages/cli/src/ui/contexts/UIStateContext.tsx`   | Add inbox state.                   |
| `packages/cli/src/ui/contexts/UIActionsContext.tsx` | Add candidate actions.             |
| `packages/cli/src/ui/commands/memoryCommand.ts`     | Add `/memory inbox`.               |
| `packages/cli/src/config/settingsSchema.ts`         | Add `memory.writePolicy`.          |

### 11.3 Verification

- Extraction completion does not interrupt input or open a dialog.
- The badge notifies at most once per session and reflects persisted counts.
- Pagination, grouping, priority, and private batch operations work.
- Team candidates cannot be batch accepted; conflicts cannot bypass digest
  checks.
- Capacity warnings clear as accepted or rejected items release space.

## 12. PR 2.3: Deferred extraction and task-level controls

Suggested commit:

```text
feat(memory): gate auto extraction by session eligibility
```

### 12.1 Eligibility

Automatic extraction requires:

- At least three non-empty user messages.
- Five minutes of idle time or a normally completed session.
- A user session rather than subagent or internal side-query context.
- No safe, bare, or incognito mode.
- Permission under the external-context policy.
- No prior processing of the same session/message boundary.

Explicit `/remember` remains immediate and writes explicit confidence. Shutdown
does not force a new agent; the next startup scans eligible unprocessed sessions.

### 12.2 External context policy

```ts
type ExternalContextContributionPolicy = 'never' | 'review' | 'allow';
```

The default is `never`. Tasks using web, MCP, tool search, browser, or external
document connectors do not contribute automatically unless configured. Under
`review`, all resulting candidates go to the inbox. Tool output can never be
marked as explicit or user-asserted evidence.

### 12.3 Session controls

```text
/memory session use on|off
/memory session contribute on|off
/memory session incognito on|off
```

Incognito disables both recall and contribution for the current session without
changing persistent settings.

Enabling incognito cancels unfinished extraction for the current session.
Messages sent while incognito do not count toward the three-message threshold
and do not update an extraction cursor or state. Disabling it later does not
retroactively ingest those messages. Incognito affects future recall and
contribution only: memory already injected into the model conversation cannot
be removed, so strict isolation requires a new session.

### 12.4 File changes

Add:

```text
packages/core/src/memory/extraction-eligibility.ts
packages/core/src/memory/extraction-eligibility.test.ts
packages/core/src/memory/extraction-state.ts
packages/core/src/memory/extraction-state.test.ts
```

Modify:

| File                                                           | Change                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/core/src/core/client.ts`                             | Replace per-turn extraction with eligibility scheduling. |
| `packages/core/src/memory/manager.ts`                          | Deferred timer and startup recovery scan.                |
| `packages/core/src/memory/extract.ts`                          | Consume an eligible session snapshot.                    |
| `packages/core/src/config/config.ts`                           | Settings and session overrides.                          |
| `packages/cli/src/config/settingsSchema.ts`                    | Policies, minimum messages, and idle duration.           |
| `packages/cli/src/config/config.ts`                            | Pass settings to core.                                   |
| `packages/vscode-ide-companion/schemas/settings.schema.json`   | Regenerate schema.                                       |
| `packages/desktop/packages/shared/src/config/qwen-settings.ts` | Update desktop types.                                    |
| `packages/cli/src/ui/commands/memoryCommand.ts`                | Add session commands.                                    |
| `packages/cli/src/ui/components/MemoryDialog.tsx`              | Display session memory state.                            |
| `docs/users/features/memory.md`                                | Document new behavior.                                   |
| `docs/users/configuration/settings.md`                         | Document settings.                                       |

### 12.5 Verification

- Short and active sessions do not extract.
- Eligible idle sessions produce candidates once.
- An interrupted session is picked up on the next startup.
- External-context tasks do not contribute by default.
- Explicit remember bypasses automatic eligibility but not secret validation.
- Incognito neither reads nor writes memory.
- Team candidates strip private provenance.

---

# Phase 3: Retrieval quality and lifecycle

## 13. PR 3.1: Full catalog, BM25, and model reranking

Suggested commit:

```text
feat(memory): add hybrid lexical and model retrieval
```

### 13.1 Retrieval pipeline

1. Build a full catalog of active memory documents.
2. Tokenize with the Phase 1 Unicode tokenizer.
3. Start weighted BM25 and model recall concurrently.
4. Remove expired and superseded entries.
5. Apply confidence, scope, and small freshness tie-breakers.
6. Prefer model results that settle within the initial-turn budget; otherwise
   inject only high-confidence local matches, at most two.
7. Send BM25 top 20 to model reranking for refinement.
8. Fill the total result set to at most five without injecting weak matches to
   satisfy a quota.

Suggested field weights:

| Field            | Weight |
| ---------------- | -----: |
| Title/name       |    4.0 |
| Description      |    3.0 |
| Summary          |    2.0 |
| Why/how to apply |    1.0 |
| Type/scope       |    0.5 |

These weights are starting hypotheses, not accepted constants. Build 50–100
annotated `query -> relevant memory` cases, targeting at least 100 as the corpus
matures, with multilingual queries and multiple valid documents. Keep a held-
out set and compare legacy, bigram, BM25, and BM25 plus reranking with Recall@5,
MRR@5, nDCG@5, irrelevant@5, and latency. Keep weights as code constants rather
than user settings until evaluation demonstrates a stable benefit.

Project scope wins a tie over user scope. Explicit and asserted confidence win
over inference. Freshness cannot override a clearly stronger lexical match.

### 13.2 Catalog size

Change topic scanning so recall can see up to 5,000 documents. `MEMORY.md`
remains capped at 200 lines and 25 KB. Emit a warning and telemetry beyond the
catalog safety limit rather than silently selecting only the newest 200.

### 13.3 Usage state

Store recall counts and timestamps outside Markdown to avoid mtime changes and
team Git churn. Writes are debounced and atomic.

### 13.4 File changes

Add:

```text
packages/core/src/memory/bm25.ts
packages/core/src/memory/bm25.test.ts
packages/core/src/memory/retrieval-index.ts
packages/core/src/memory/retrieval-index.test.ts
packages/core/src/memory/memory-usage-store.ts
packages/core/src/memory/memory-usage-store.test.ts
packages/core/src/memory/retrieval-eval.test.ts
packages/core/src/memory/testdata/retrieval-eval.json
```

Modify:

| File                                            | Change                                             |
| ----------------------------------------------- | -------------------------------------------------- |
| `packages/core/src/memory/scan.ts`              | Full catalog scan with a separate safety cap.      |
| `packages/core/src/memory/indexer.ts`           | Keep prompt-index truncation independent.          |
| `packages/core/src/memory/recall.ts`            | Use the retrieval index and BM25 ranking.          |
| `packages/core/src/memory/relevanceSelector.ts` | Rerank top 20 and receive short evidence snippets. |
| `packages/core/src/memory/manager.ts`           | Cache and invalidate the catalog.                  |
| `packages/core/src/memory/candidates.ts`        | Invalidate after application.                      |
| `packages/core/src/memory/remember.ts`          | Invalidate after explicit writes.                  |
| `packages/core/src/memory/forget.ts`            | Invalidate after delete or undo.                   |
| `packages/core/src/memory/dream.ts`             | Invalidate after consolidation application.        |

### 13.5 Shadow rollout

```ts
type MemoryRetrievalMode = 'legacy' | 'shadow' | 'hybrid';
```

Shadow mode runs the new local ranker but injects legacy results. Record result
count, top-k overlap, and latency without recording document identity.

Keep `legacy` as the default. Enable `hybrid` only when the annotated set shows
no Recall@5 or MRR regression, irrelevant results and initial latency meet their
gates, and online delivery/correction signals show no regression. The
`fast 2 + refined 3` allocation remains a maximum rather than a quota.

### 13.6 Verification

Create retrieval fixtures covering multilingual preferences, deadlines,
conflicting project facts, expired entries, same-name cross-scope entries,
ticket IDs, URLs, and 200/1,000/5,000 document corpora.

| Metric                         |     Target |
| ------------------------------ | ---------: |
| Recall@5                       |    `> 90%` |
| Clearly irrelevant result rate |     `< 5%` |
| CJK versus English gap         |    `< 10%` |
| 1,000-document fast query P95  |  `< 50 ms` |
| Catalog build P95              | `< 500 ms` |
| Initial-turn added P95         | `< 200 ms` |

## 14. PR 3.2: Scoped consolidation, expiry, and conflicts

Suggested commit:

```text
feat(memory): consolidate user project and team scopes
```

### 14.1 Scope policy

| Scope   |   Default interval | New sessions | Application           |
| ------- | -----------------: | -----------: | --------------------- |
| Project |           24 hours |            5 | Private policy        |
| User    |             7 days |           20 | Private policy        |
| Team    | No automatic apply |          N/A | Candidate review only |

Dream uses the same snapshot, isolated-clone, diff, and candidate pipeline as
extraction. It no longer deletes or overwrites live memory directly.

### 14.2 Expiry

- `expires_at < now` marks a document expired.
- Expired documents do not participate in ordinary recall.
- Expiry does not immediately delete content.
- The inbox can offer archive, refresh, or delete candidates.
- Explicit historical queries may opt into expired recall.

Do not assign a mandatory TTL based only on memory type. Time-bound project
facts may receive suggested expiry during extraction or review.

### 14.3 Conflict precedence

```text
Current source verified by tool or file evidence
> QWEN.md or AGENTS.md instruction
> project explicit/asserted
> user explicit/asserted
> project inferred
> user inferred
> expired or superseded
```

Contradictions create a candidate with `supersedes`; they do not silently
replace an active record. The old record remains stored with superseded status.

Model interpretation of user intent is not a current observation. Precedence
recommends conflict handling; it never grants silent-overwrite permission.
Use `last_verified_at` only as a tie-breaker between evidence at the same level.
An inferred candidate never automatically supersedes explicit or asserted
memory and instead requires conflict review. A newly verified explicit fact may
supersede an older explicit fact with review or authoritative evidence.

### 14.4 File changes

Add:

```text
packages/core/src/memory/consolidation-policy.ts
packages/core/src/memory/consolidation-policy.test.ts
packages/core/src/memory/memory-conflicts.ts
packages/core/src/memory/memory-conflicts.test.ts
```

Modify:

| File                                                   | Change                                         |
| ------------------------------------------------------ | ---------------------------------------------- |
| `packages/core/src/memory/dream.ts`                    | Produce candidates rather than live mutations. |
| `packages/core/src/memory/dreamAgentPlanner.ts`        | Accept scope and staging paths.                |
| `packages/core/src/memory/manager.ts`                  | Per-scope scheduling and locks.                |
| `packages/core/src/memory/types.ts`                    | Per-scope consolidation metadata.              |
| `packages/core/src/memory/paths.ts`                    | Per-scope state and lock paths.                |
| `packages/core/src/memory/candidates.ts`               | Consolidation candidate types.                 |
| `packages/core/src/memory/recall.ts`                   | Filter expired and superseded entries.         |
| `packages/core/src/memory/indexer.ts`                  | Index active entries only.                     |
| `packages/cli/src/ui/commands/dreamCommand.ts`         | Add a project/user/team/all scope selector.    |
| `packages/cli/src/ui/components/MemoryInboxDialog.tsx` | Render merge, supersede, and expiry actions.   |

### 14.5 Verification

- Each consolidation scope reads and proposes changes only for that scope.
- Team consolidation never applies directly.
- Expired and superseded entries stay stored but leave ordinary recall.
- Instructions beat memory conflicts.
- Candidate digest conflicts prevent application.
- Per-scope locks work across processes.
- Cancellation removes incomplete staging without touching live memory.

## 15. PR 3.3: Routing, budgets, models, and project identity

Suggested commit:

```text
feat(memory): add routing budgets and project identity controls
```

### 15.1 Model and cost controls

```json
{
  "memory": {
    "extractionModel": "fast-model-id",
    "recallModel": "fast-model-id",
    "consolidationModel": "main-model-id",
    "dailySideQueryTokenBudget": 100000,
    "retrievalMode": "legacy"
  }
}
```

After the daily budget is exhausted:

- Local BM25 recall remains available.
- Automatic extraction is deferred.
- Automatic consolidation is skipped.
- Explicit remember remains available and reports budget state.

### 15.2 Durable knowledge routing

```ts
type DurableKnowledgeTarget = 'instruction' | 'memory' | 'skill' | 'ignore';
```

| Content                            | Route                 |
| ---------------------------------- | --------------------- |
| Always-follow team rule            | Instruction candidate |
| User preference or project context | Memory candidate      |
| Repeatable procedure               | Skill candidate       |
| Temporary task state               | Ignore                |

Instruction and skill routes are candidates only. They never allow extraction
to directly edit QWEN/AGENTS or the skill library.

Add:

```text
packages/core/src/memory/memory-routing.ts
packages/core/src/memory/memory-routing.test.ts
```

Modify `extractionAgentPlanner.ts`, `prompt.ts`, `skillReviewAgentPlanner.ts`,
`pending-skills.ts`, `MemoryInboxDialog.tsx`, and `SkillReviewDialog.tsx`.

### 15.3 Project identity

```ts
type MemoryProjectIdentity = 'worktree' | 'repository';
```

Keep `worktree` as the default. Repository mode shares private project memory
across linked worktrees using canonical repository identity. Team memory stays
in the active worktree so changes remain visible in its Git diff.

Switching identity never automatically moves or deletes memory. The Memory
dialog shows the active location and offers migration preview separately.

### 15.4 File changes

| File                                                           | Change                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/core/src/memory/paths.ts`                            | Project identity resolution.                               |
| `packages/core/src/config/config.ts`                           | Models, budgets, retrieval mode, and identity settings.    |
| `packages/cli/src/config/settingsSchema.ts`                    | New settings schema.                                       |
| `packages/cli/src/ui/components/MemoryDialog.tsx`              | Show models, policy, budget state, and actual memory path. |
| `packages/vscode-ide-companion/schemas/settings.schema.json`   | Regenerate schema.                                         |
| `packages/desktop/packages/shared/src/config/qwen-settings.ts` | Update desktop types.                                      |

### 15.5 Verification

- Side queries use their configured models without changing the main session
  model.
- Budget exhaustion preserves local recall and explicit remember.
- Instruction, memory, skill, and ignore routing is deterministic for fixtures.
- No route directly writes instructions or skills.
- Worktree remains the default identity.
- Repository identity shares private project memory across linked worktrees.
- Switching identity leaves old data intact and discoverable.

---

# 16. Complete file impact

## 16.1 Primary existing core files

```text
packages/core/src/core/client.ts
packages/core/src/config/config.ts
packages/core/src/memory/types.ts
packages/core/src/memory/paths.ts
packages/core/src/memory/entries.ts
packages/core/src/memory/scan.ts
packages/core/src/memory/indexer.ts
packages/core/src/memory/prompt.ts
packages/core/src/memory/store.ts
packages/core/src/memory/manager.ts
packages/core/src/memory/extract.ts
packages/core/src/memory/extractionAgentPlanner.ts
packages/core/src/memory/recall.ts
packages/core/src/memory/relevanceSelector.ts
packages/core/src/memory/remember.ts
packages/core/src/memory/forget.ts
packages/core/src/memory/dream.ts
packages/core/src/memory/dreamAgentPlanner.ts
packages/core/src/memory/memory-scoped-agent-config.ts
packages/core/src/memory/secret-scanner.ts
packages/core/src/memory/team-memory-sync.ts
packages/core/src/tools/write-file.ts
packages/core/src/tools/edit.ts
packages/core/src/telemetry/constants.ts
packages/core/src/telemetry/types.ts
packages/core/src/telemetry/loggers.ts
packages/core/src/telemetry/metrics.ts
packages/core/src/telemetry/index.ts
```

## 16.2 Proposed core files

```text
packages/core/src/memory/managed-memory-secret-guard.ts
packages/core/src/memory/memory-document.ts
packages/core/src/memory/memory-provenance-store.ts
packages/core/src/memory/memory-snapshot.ts
packages/core/src/memory/candidates.ts
packages/core/src/memory/candidate-store.ts
packages/core/src/memory/candidate-gc.ts
packages/core/src/memory/extraction-eligibility.ts
packages/core/src/memory/extraction-state.ts
packages/core/src/memory/bm25.ts
packages/core/src/memory/retrieval-index.ts
packages/core/src/memory/memory-usage-store.ts
packages/core/src/memory/consolidation-policy.ts
packages/core/src/memory/memory-conflicts.ts
packages/core/src/memory/memory-routing.ts
```

Each new production file must have a collocated Vitest file.

## 16.3 CLI and configuration files

```text
packages/cli/src/config/settingsSchema.ts
packages/cli/src/config/config.ts
packages/cli/src/ui/AppContainer.tsx
packages/cli/src/ui/components/DialogManager.tsx
packages/cli/src/ui/components/MemoryDialog.tsx
packages/cli/src/ui/components/MemoryInboxDialog.tsx
packages/cli/src/ui/contexts/UIStateContext.tsx
packages/cli/src/ui/contexts/UIActionsContext.tsx
packages/cli/src/ui/commands/memoryCommand.ts
packages/cli/src/ui/commands/rememberCommand.ts
packages/cli/src/ui/commands/forgetCommand.ts
packages/cli/src/ui/commands/dreamCommand.ts
packages/vscode-ide-companion/schemas/settings.schema.json
packages/desktop/packages/shared/src/config/qwen-settings.ts
docs/users/features/memory.md
docs/users/configuration/settings.md
```

# 17. Verification strategy

## 17.1 Focused unit tests

Run tests from their package directories:

```bash
cd packages/core
npx vitest run src/memory/recall.test.ts
npx vitest run src/memory/relevanceSelector.test.ts
npx vitest run src/memory/memory-document.test.ts
npx vitest run src/memory/memory-provenance-store.test.ts
npx vitest run src/memory/candidates.test.ts
npx vitest run src/memory/candidate-store.test.ts
npx vitest run src/memory/candidate-gc.test.ts
npx vitest run src/memory/memory-snapshot.test.ts
npx vitest run src/memory/extraction-eligibility.test.ts
npx vitest run src/memory/extraction-state.test.ts
npx vitest run src/memory/bm25.test.ts
npx vitest run src/memory/retrieval-index.test.ts
npx vitest run src/memory/memory-usage-store.test.ts
npx vitest run src/memory/retrieval-eval.test.ts
npx vitest run src/memory/consolidation-policy.test.ts
npx vitest run src/memory/memory-conflicts.test.ts
npx vitest run src/memory/memory-routing.test.ts
npx vitest run src/memory/forget.test.ts
npx vitest run src/memory/manager.test.ts
npx vitest run src/memory/memoryLifecycle.integration.test.ts
npx vitest run src/core/client.test.ts
npx vitest run src/telemetry/loggers.test.ts
npx vitest run src/telemetry/metrics.test.ts
```

```bash
cd packages/cli
npx vitest run src/ui/components/MemoryDialog.test.tsx
npx vitest run src/ui/components/MemoryInboxDialog.test.tsx
npx vitest run src/ui/commands/memoryCommand.test.ts
npx vitest run src/ui/commands/forgetCommand.test.ts
npx vitest run src/ui/hooks/slashCommandProcessor.test.ts
npx vitest run src/acp-integration/session/Session.test.ts
```

## 17.2 Integration and fault injection

Exercise the full chain:

```text
conversation
→ eligibility
→ staged extraction
→ candidate
→ review or auto-apply
→ index rebuild
→ catalog invalidation
→ next-session recall
→ consolidation candidate
```

Inject failures for agent timeout, no tool calls, corrupt manifests, concurrent
target edits, ENOSPC, EACCES, symlinked team roots, diverged Git branches,
unsettled recall models, shutdown, and hard/critical memory pressure.

## 17.3 E2E plans

Create ignored working plans:

```text
.qwen/e2e-tests/auto-memory-phase-1.md
.qwen/e2e-tests/auto-memory-phase-2.md
.qwen/e2e-tests/auto-memory-phase-3.md
```

Minimum scenarios:

1. Multilingual preference recall across sessions.
2. Fast recall while model recall hangs.
3. Forget cancel, confirm, undo, and conflict.
4. Secret blocking in all scopes.
5. Review policy leaves live memory unchanged.
6. Auto-private policy applies a valid private candidate.
7. Team candidates always require review.
8. External-context tasks do not contribute by default.
9. Incognito neither reads nor writes.
10. v1 memory remains readable after upgrade.
11. Retrieval remains within latency targets at 1,000 and 5,000 documents.
12. Consolidation remains scope-isolated.
13. Worktree and repository identity modes behave as documented.

## 17.4 Performance benchmark

Create an ignored benchmark helper:

```text
.qwen/scripts/benchmark-memory-recall.mjs
```

Measure cold and warm catalog build, BM25 query time, fast recall, initial-turn
latency, prompt characters, and heap growth at 10, 100, 1,000, and 5,000
documents across English, Chinese, Japanese, and mixed queries.

## 17.5 Final checks

Every PR runs focused tests plus:

```bash
npm run build
npm run typecheck
npm run lint
```

Each completed phase runs:

```bash
npm run preflight
```

# 18. Rollout and rollback

## 18.1 Rollout

1. Release Phase 1 without format migration.
2. Release the v2 reader before enabling v2 writers.
3. Release candidate staging infrastructure without behavior changes.
4. Route extraction through staging in shadow mode before enabling application.
5. Release the non-blocking inbox before making `review` selectable.
6. Preserve `auto-private` semantics for existing enabled installations.
7. Run hybrid retrieval in shadow mode and meet quality gates before injection.
8. Enable project and user consolidation separately.
9. Keep team consolidation review-only.

## 18.2 Rollback

| Change             | Rollback                                                 |
| ------------------ | -------------------------------------------------------- |
| Two-phase recall   | Revert to legacy recall; memory files are unchanged.     |
| Schema v2          | Old readers still see type, name, description, and body. |
| Candidate pipeline | Disable generation; pending directories remain isolated. |
| Inbox UI           | Pending candidates remain available for a later version. |
| Hybrid retrieval   | Set `retrievalMode=legacy`.                              |
| User consolidation | Disable the user-scope scheduler.                        |
| Team consolidation | Stop candidate generation; no live rollback is required. |
| Project identity   | Return to `worktree`; old directories remain intact.     |

No phase automatically deletes old memory directories or rewrites every stored
document.

# 19. Completion metrics

| Metric                                    |     Target |
| ----------------------------------------- | ---------: |
| Unconsumed recall rate                    |     `< 1%` |
| Recall@5                                  |    `> 90%` |
| CJK versus English recall gap             |    `< 10%` |
| Clearly irrelevant recall rate            |     `< 5%` |
| Initial-turn added P95                    | `< 200 ms` |
| Candidate schema failure rate             |     `< 1%` |
| Auto-private application conflict rate    |     `< 1%` |
| Candidate drift after confirmation        |        `0` |
| New secrets entering managed memory       |        `0` |
| Unreviewed team writes                    |        `0` |
| Expired memory affecting ordinary answers |     `< 1%` |
| v1 compatibility                          |     `100%` |
| Observable automatic operations           |     `100%` |

# 20. Suggested reviewers

| Area                            | Suggested reviewers based on recent ownership   |
| ------------------------------- | ----------------------------------------------- |
| Recall and CJK                  | `LaZzyMan` (顾盼), Yufeng He, John London, 易良 |
| Forget                          | callmeYe, `LaZzyMan`                            |
| Secret scanning and team memory | qqqys, 易良                                     |
| Schema and extraction           | `LaZzyMan`, lcheng                              |
| Inbox and CLI                   | callmeYe                                        |
| Dream and background tasks      | Shaojin Wen, Zqc                                |
| Paths and worktrees             | Nothing Chan, qqqys                             |

The implementation order is deliberate: make recall and deletion reliable,
make writes trustworthy and reviewable, then improve retrieval and lifecycle
management. Each phase delivers independent value and can be rolled back
without replacing the existing Markdown memory store.
