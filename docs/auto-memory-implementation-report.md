# Auto-Memory 功能实现报告

## 1. 结论摘要

当前实现已经完成设计文档中的 **Part 1–5 全部既定 MVP 范围**，形成了一套可运行、可测试、可观察的 managed auto-memory 子系统，覆盖：

- 独立存储层：`.qwen/memory/`
- 主提示词集成：`MEMORY.md` 索引并入 `userMemory`
- 查询时相关记忆召回：按 query 注入 relevant memory block
- turn-end 自动提炼：从当前 session transcript 增量抽取 durable memory
- dream/consolidation：手动触发的去重整理
- CLI 入口：`/memory status`、`/memory extract-now`、`/dream`、`/remember`

如果以“**设计文档的第一阶段目标**”衡量，当前实现是 **已完成**。

如果以“**Claude Code 当前完整 memory system 的实际能力**”衡量，当前实现是 **中高完成度的 MVP**：

- **已对齐**：taxonomy、独立 memory 目录、显式保存入口、基础 recall、基础 extract、基础 dream、基本命令入口。
- **未完全对齐**：Claude 的模型驱动 recall、forked extractor、后台 auto-dream 调度、task 可视化、forget/governance 深水区、team/private 双层 memory。

## 2. 对比基线

### 2.1 设计文档基线

设计目标来自 [auto-memory-doc/02-technical-design.md](../auto-memory-doc/02-technical-design.md)，核心要求是：

1. 独立 managed memory 存储层
2. relevant memory recall
3. turn-end 自动提炼
4. 周期性 consolidation / dream
5. 保持对 `QWEN.md` / `AGENTS.md` / `save_memory` 的兼容

### 2.2 Claude Code 对标基线

Claude 当前 memory system 的关键能力，可从以下实现侧看到：

- taxonomy 与 memory prompt 规则： [src/memdir/memoryTypes.ts](../src/memdir/memoryTypes.ts)
- query 相关记忆选择： [src/memdir/findRelevantMemories.ts](../src/memdir/findRelevantMemories.ts)
- turn-end extractor： [src/services/extractMemories/extractMemories.ts](../src/services/extractMemories/extractMemories.ts)
- background auto-dream： [src/services/autoDream/autoDream.ts](../src/services/autoDream/autoDream.ts)

## 3. 当前实现概览

当前 Qwen 实现位于 memory-worktree，主要落点如下：

- storage/scaffold： [packages/core/src/memory/store.ts](packages/core/src/memory/store.ts)
- managed index prompt： [packages/core/src/memory/prompt.ts](packages/core/src/memory/prompt.ts)
- topic 扫描： [packages/core/src/memory/scan.ts](packages/core/src/memory/scan.ts)
- recall： [packages/core/src/memory/recall.ts](packages/core/src/memory/recall.ts)
- extraction： [packages/core/src/memory/extract.ts](packages/core/src/memory/extract.ts)
- dream： [packages/core/src/memory/dream.ts](packages/core/src/memory/dream.ts)
- 配置集成： [packages/core/src/config/config.ts](packages/core/src/config/config.ts)
- client 注入/触发： [packages/core/src/core/client.ts](packages/core/src/core/client.ts)
- CLI 命令： [packages/cli/src/ui/commands/memoryCommand.ts](packages/cli/src/ui/commands/memoryCommand.ts)、[packages/cli/src/ui/commands/dreamCommand.ts](packages/cli/src/ui/commands/dreamCommand.ts)、[packages/cli/src/ui/commands/rememberCommand.ts](packages/cli/src/ui/commands/rememberCommand.ts)
- 命令注册： [packages/cli/src/services/BuiltinCommandLoader.ts](packages/cli/src/services/BuiltinCommandLoader.ts)
- 交付记录： [docs/auto-memory-work-log.md](docs/auto-memory-work-log.md)

## 4. 与设计文档的逐项对比

### 4.1 Storage Layer

**设计要求**

- 独立 `.qwen/memory/` 目录
- `MEMORY.md` + topic files + `meta.json` + `extract-cursor.json`
- 与 `QWEN.md` 分离

**当前实现**

- 已实现 `MEMORY.md`、`meta.json`、`extract-cursor.json`
- 已实现 4 个 topic files：`user.md`、`feedback.md`、`project.md`、`reference.md`
- 已保持机器维护内容不写回 `QWEN.md`

**结论**

- **已完成，且与文档一致。**

**说明**

- taxonomy 已严格对齐 Claude 的 4 类，而没有引入文档中被明确降级为后续扩展的 `workflow` / `debugging` 等分类。

### 4.2 Prompt / Compatibility Layer

**设计要求**

- 与 `QWEN.md` / `AGENTS.md` / `save_memory` 兼容
- managed memory 以低侵入方式并入现有 prompt 体系

**当前实现**

- `refreshHierarchicalMemory()` 会在原有 hierarchical memory 基础上追加 managed index
- 现有 `save_memory` 行为未被破坏
- 原有 `QWEN.md` / `AGENTS.md` 发现逻辑未修改

**结论**

- **已完成。**

### 4.3 Recall Layer

**设计要求**

- 扫描 memory 元数据
- 基于 query 做相关性筛选
- 构造注入 prompt
- 控制 token 成本

**当前实现**

- 已实现 topic 文件扫描与 frontmatter 解析
- 已实现 query-token + type-keyword 的启发式评分选择
- 已在 `UserQuery` 请求路径下注入 `Relevant Managed Auto-Memory` block
- 已对单文档注入体做截断

**结论**

- **MVP 已完成。**

**与文档差异**

- 文档没有强制要求必须模型驱动；当前实现采用启发式检索，风险更低，但召回质量上限低于 Claude。

### 4.4 Extraction Layer

**设计要求**

- turn-end 异步触发
- 基于 transcript 增量提炼
- 幂等与 cursor 控制
- 可独立关闭/回滚

**当前实现**

- 已在完成 `UserQuery` 后触发 extraction
- 已用 `extract-cursor.json` 维护 session-aware 增量游标
- 已实现同进程并发保护
- 已做 topic file 幂等追加与 metadata 更新时间维护

**结论**

- **MVP 已完成。**

**与文档差异**

- 文档中更理想的方案是 headless extractor agent + structured memory patch。
- 当前实现是 **host 侧启发式抽取**，不是独立 extractor agent。
- 因此当前版本在复杂总结、跨消息归纳、why/how 提炼方面弱于文档理想态。

### 4.5 Dream Layer

**设计要求**

- 周期性 consolidation
- 去重、重组、更新索引
- 并发锁与状态管理

**当前实现**

- 已实现手动触发的 dream primitive
- 已实现 topic file bullet 去重、排序、占位恢复、metadata bump

**结论**

- **MVP 部分完成。**

**未达成点**

- 尚未实现自动调度
- 尚未实现 consolidation lock 文件
- 尚未实现模型驱动重写/提纯/重组
- 尚未重写 `MEMORY.md` 索引摘要

### 4.6 Control / Observability Layer

**设计要求**

- lock
- cursor
- debug 日志
- CLI 命令
- task / governance 可观测性
- richer durable schema

**当前实现**

- 已实现 cursor
- 已实现 consolidation lock、dream/extraction task registry 与 CLI 可视化
- 已实现 `/memory status`、`/memory tasks`、`/memory inspect`、`/memory review`、`/memory forget`、`/forget`
- 已通过 system message、task timeline 与 governance review 暴露 memory 更新结果
- 已引入 `why` / `howToApply` / `stability` richer schema

**结论**

- **大部完成。**

**缺口**

- task UI 仍可继续向更完整的交互式观察体验打磨
- team/private 双层 memory 仍未纳入当前范围

## 5. 与 Claude Code memory system 的对比

### 5.1 已基本对齐的能力

#### 1) Memory taxonomy

Qwen 当前实现使用 `user` / `feedback` / `project` / `reference` 四类，已与 Claude 的 taxonomy 对齐，符合 [src/memdir/memoryTypes.ts](../src/memdir/memoryTypes.ts) 的实际定义。

#### 2) 独立 managed memory 存储

Claude 将 auto-memory 独立于人工维护 memory 文件；Qwen 当前也已做到这一点，避免把机器维护内容继续塞入 `QWEN.md`。

#### 3) 显式记忆写入入口

Claude 支持在主对话里直接 remember；Qwen 当前通过 `/remember` 和既有 `save_memory` 工具实现了同类显式入口。

#### 4) 查询时 relevant recall

两边都在主请求前追加相关记忆，而不是把所有 topic 文件完整灌入 prompt。

### 5.2 部分对齐、但实现深度不同的能力

#### 1) Recall 选择机制

Claude 的 recall 选择是 **side-query + 模型判定**，见 [src/memdir/findRelevantMemories.ts](../src/memdir/findRelevantMemories.ts)。

Qwen 当前是 **启发式 token/keyword 评分**。

影响：

- 优点：更稳定、成本更低、实现风险更小
- 缺点：语义召回能力弱，难处理隐式关联和复杂描述

#### 2) Extraction 实现形态

Claude 的 extractor 是 **forked agent**，具备：

- 只读探索 + memory 目录限域写入
- 依据 prompt 进行结构化提炼
- 主 agent 已经写 memory 时可跳过 extractor
- 正在运行时支持 trailing run / stash 行为

对应实现见 [src/services/extractMemories/extractMemories.ts](../src/services/extractMemories/extractMemories.ts)。

Qwen 当前 extraction 是 **本地启发式规则抽取**。

影响：

- 优点：轻量、可预测、容易验证
- 缺点：对复杂对话、跨 turn 归纳、why/how 结构化沉淀明显不如 Claude

#### 3) Dream 实现形态

Claude 的 dream 是 **后台 forked consolidation agent**，并带有：

- 时间门限
- session 数门限
- consolidation lock
- background dream task
- progress watcher
- 完成/失败/中止状态流转

对应实现见 [src/services/autoDream/autoDream.ts](../src/services/autoDream/autoDream.ts)。

Qwen 当前 dream 仅为 **手动 dedupe/normalize**。

影响：

- 当前只能算 dream 的低风险占位版
- 还不具备 Claude 的后台整理能力和任务可视化能力

### 5.3 尚未对齐的能力

#### 1) 自动后台 dream 调度

Claude 有 stop-hook/background housekeeping 驱动的 auto-dream；Qwen 当前无自动调度。

#### 2) Dream / Extract 任务可视化

Claude 有 `DreamTask` 等任务态展示；Qwen 当前只有简要 system message / CLI 结果文本。

#### 3) Forget / memory 治理闭环

Claude 的“完整记忆系统”不仅有 remember，也强调治理、审查、整理。

Qwen 当前：

- 有 `/memory show`、`/memory status`
- 有 `/remember`
- 有 `/dream`
- **但没有显式 `/forget`**
- **也没有更深入的 memory 审查/提升/迁移工作流**

#### 4) Team/private 双层 memory

Claude 代码里已经考虑 private/team 语义；Qwen 当前第一阶段未覆盖，这与设计文档非目标一致，不算偏航，但属于 Claude parity 未完成项。

## 6. 功能完成度判断

### 6.1 按设计文档第一阶段判断

| 领域 | 结论 |
| --- | --- |
| 存储 scaffold | 完成 |
| 索引 prompt 集成 | 完成 |
| relevant recall | 完成（MVP） |
| turn-end extraction | 完成（MVP） |
| dream primitive | 部分完成 |
| CLI 入口 | 完成（MVP） |
| 兼容 `QWEN.md` / `AGENTS.md` / `save_memory` | 完成 |

总体判断：**文档第一阶段目标已完成。**

### 6.2 按 Claude Code parity 判断

| 领域 | 完成度 |
| --- | --- |
| taxonomy / storage 形态 | 高 |
| prompt 集成与兼容性 | 高 |
| explicit remember | 高 |
| recall 能力深度 | 中 |
| extraction 能力深度 | 中 |
| dream 能力深度 | 低到中 |
| memory 治理与审查 | 中偏低 |
| 后台任务与状态可视化 | 低 |

总体判断：**已达到 Claude 风格 memory system 的 MVP 骨架，但还未达到 Claude 当前实现深度。**

## 7. 已完成验证

根据 [docs/auto-memory-work-log.md](docs/auto-memory-work-log.md) 的记录，当前实现已完成：

- core 定向测试
- core 回归测试
- cli 定向测试
- core / cli typecheck
- 工作日志记录
- 分阶段提交

关键提交：

- Part 4：`a5b6683f8` — `feat(core): add managed auto-memory extraction`
- Part 5：`eefd3e9d0` — `feat(cli): add managed auto-memory dream commands`

## 8. 主要缺口与后续建议

### 优先级 P1

1. 将 extraction 从启发式规则升级为模型驱动 extractor
2. 为 dream 增加自动调度、锁和最小状态记录
3. 重写 `MEMORY.md`，让它真正反映 topic 文件摘要，而不只是 scaffold index

### 优先级 P2

1. 增加 `/forget` 或等效治理入口
2. 为 `/memory` 增加更完整的 topic 审查/编辑/迁移视图
3. 为 durable memory 引入更丰富的结构化 schema 与治理辅助信息

### 优先级 P3

1. 引入 task 级可视化或后台状态面板
2. 评估 team/private 双层 memory
3. 继续打磨治理建议的交互体验与执行闭环

## 9. 最终判断

当前实现不是“半成品”，而是一个 **已经闭环的第一阶段交付**：

- 有存储
- 有注入
- 有召回
- 有自动提炼
- 有手动整理
- 有命令入口
- 有测试验证

但如果目标是 **严格追平 Claude Code 当前 memory system 的行为深度和运营能力**，那么当前仍属于：

**结构完成、能力可用、深度未完全追平。**

更准确地说：

- **对设计文档：已完成第一阶段目标**
- **对 Claude Code：已完成 MVP 级别对标，未完成 full parity**

## 10. 当前版本相对 Claude Code 的对齐情况

> 本章基于当前 `feat/auto-memory` 分支的最新实现状态补充。若与前文较早阶段的判断存在差异，以本章为准。

### 10.1 当前已经完成或基本对齐的内容

1. **memory taxonomy 与 managed 存储形态**
	- 已采用 `user` / `feedback` / `project` / `reference` 四类 taxonomy。
	- 已维护独立 `.qwen/memory/` 目录，包含 `MEMORY.md`、topic files、`meta.json`、`extract-cursor.json` 与 `consolidation.lock`。

2. **recall 主链路**
	- 已实现模型驱动 relevance selector。
	- 已保留 heuristic fallback。
	- 已实现 surfaced memory 的会话级去重。
	- 在“主请求前注入 relevant memories”这一能力形态上，已与 Claude Code 基本对齐。

3. **extraction 主链路**
	- 已从单纯规则抽取升级为：agent planner → side-query planner → heuristic fallback。
	- agent stage B 已支持受限 `read_file`、多轮预算、`filesTouched`、`roundCount` 与 cancelled 状态。
	- 说明 Qwen 已进入模型驱动 extraction 阶段。

4. **dream / consolidation 主链路**
	- 已具备 auto-dream 调度、时间/会话门限、`consolidation.lock`、background task registry、agent-first planner 与 mechanical fallback。
	- 这意味着 Qwen 已不再只是手动 `/dream` 的占位实现。

5. **动态 `MEMORY.md` 索引**
	- `MEMORY.md` 已会随 extraction、dream、forget 自动重写。
	- 已与 Claude 把 `MEMORY.md` 作为“索引入口”而非正文存储位的设计基本一致。

6. **governance 基础入口**
	- 当前已提供 `/memory status`、`/memory tasks`、`/memory inspect`、`/memory forget`、`/forget`、`/dream`、`/remember`。
	- 已经具备基础治理入口，而不只是写入入口。

7. **通用 runtime 基础设施**
	- 已具备 shared side-query、background task runtime、`BackgroundAgentRunner`。
	- 从结构分层看，Qwen 已补齐 Claude memory system 很大一部分公共底座。

8. **extraction 完整后台生命周期**
	- 已补齐 extraction runtime、trailing queue、pending drain、save_memory 同轮 skip 与 extraction task tracking。
	- 在 turn-end 提炼的后台语义上，已明显接近 Claude 的运行形态。

9. **task UI 深度可视化**
	- `/memory status` 与 `/memory tasks` 已展示 extraction / dream 双 lane、timeline、progressText 与关键 metadata。
	- 任务可观测性已不再停留在简单 system message 层面。

10. **治理建议流与 richer schema**
	- 已新增 governance review，支持 duplicate / conflict / outdated / promote / migrate / forget suggestion。
	- 已补齐 durable entry richer schema：`why`、`howToApply`、`stability`，并打通 extract / dream / index / forget 链路。

11. **模型辅助 forget candidate 选择**
	- `/forget` 与 `/memory forget` 已升级为 preview-first + `--apply` 确认流。
	- forget 候选选择已支持 side-query / heuristic 双路径，而不再只是直接 substring 删除。

### 10.2 当前仍等待与 Claude Code 进一步对齐的部分

1. **team/private 双层 memory**
	- 当前仍以单层 managed memory 为主，未完成更复杂的 scope 语义。
	- 这一项仍属于 Claude 更复杂的 memory scope 语义，不在当前 Qwen Code 目标范围内。

### 10.3 现阶段总体判断

如果只看“第一阶段 MVP 是否完成”，答案已经是 **完成**。

如果看“当前版本相对 Claude Code 到底完成了什么”，更准确的判断是：

- **主干结构：已基本对齐**
- **主要链路：除 team/private scope 外已基本具备对应能力形态**
- **执行深度与治理成熟度：已进入可用且可治理阶段**

可以把当前状态概括为：结构对齐高，主能力链路对齐高，治理成熟度中高，任务可视化/UI 深度中高；若排除 team/private scope，已接近 Claude 当前 memory system 的主要能力面。

因此，Qwen 当前已经不再只是“memory MVP 原型”，而是进入了“**从结构对齐走向深度对齐**”的阶段。
