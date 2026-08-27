# PR #10183 Structured Memory Review 收敛实施清单

## 1. 文档状态

- PR：https://github.com/QwenLM/qwen-code/pull/10183
- 分支：`codex/model-pull-memory-from-main`
- 基线提交：`5f4d5c0d13c21b15aab0ed0a716c110253389bb8`
- 记录时间：2026-08-27
- 当前未解决 review：16 条 Critical、45 条 Suggestion
- 当前 CI：Ubuntu、Web Shell、依赖审计和 Secret Scan 等已通过；当前阻塞来自 review，而不是红色 CI。

本文档合并以下信息：

- 当前 PR 最新 HEAD 上仍有效的 GitHub review threads。
- 此前多轮 review 中尚需明确处理或延期的意见。
- 隔离迁移测试 `memory-migration-real-chain-r6-20260826-173158` 的结论。
- 已经修复、已经证伪或明确不在本 PR 处理的问题。

## 2. 收敛原则

1. 当前 PR 已经过超过五轮 review，优先落地 correctness、security、data loss 和确定性 regression 修复。
2. Review 标签不是唯一判断依据。Suggestion 中已经通过 probe 证明的真实行为缺陷、协议不一致、数据生命周期问题和关键测试缺口也直接在本 PR 解决，不延期。
3. 每个修复采用最小改动，优先复用已有能力边界、状态接口和 parser。
4. 不增加 speculative hardening，不为单一调用新增通用抽象。
5. 每条接受的 review 必须有 focused regression test；修复后在原 inline thread 回复并 resolve。
6. 不提交评测脚本、隔离语料、运行日志和 HTML 报告。

## 3. 当前设计边界

### 3.1 Structured 主模型

- Complete Memory Tree 提供全局 `category/ref/title` 层次。
- Focused Subtree 提供本轮相关 metadata。
- `search_memory` 按需读取正文，并维护正文是否仍存在于上下文的状态。
- 普通 structured 主模型不能通过通用文件工具直接读取 managed memory。

### 3.2 Memory scoped Agent

- Dream、User Dream、Extraction 和 Remember 使用受限的 scoped config。
- `allowsDirectAutoMemoryRead()` 和 `allowsDirectAutoMemoryWrite()` 是直接访问 managed memory 的统一能力开关。
- Generic subagent 不自动获得以上能力。
- `pinned/` 是用户保护区，后台 Agent 不得写入、移动、合并或删除。

### 3.3 迁移

- 旧语料继续使用 legacy 链路，所有可见 scope 完成 metadata 迁移后才切换 structured 链路。
- Project scope 由 managed-memory root 决定，不由相对路径第一段决定。
- `<project>/.qwen/memory/user/*.md` 仍是 Project Memory；全局 User Memory 位于 `~/.qwen/memories/` 或隔离测试指定的 memory base dir。
- 每批最多尝试 10 条且最多读取 40,000 字符正文。
- 当前调度每个符合条件的完成 UserQuery 最多启动一批；运行中的同 domain 调度返回 `running`，不自动排队下一批。

## 4. P0：当前 PR 必须修复的 16 条 Critical

### P0.1 ACP 提交 Complete Tree revision 和 delivery telemetry

- Thread：[R3867105673](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105673)
- 问题：ACP 调用 `consumeManagedAutoMemoryRecall()` 后只使用 `prompt`，没有提交 `deliveredTreeRevision`，也没有处理 `deliveryEvent`。Complete Tree 因此在 ACP 每轮重复注入。
- 修复：为 ACP 的实际发送边界增加明确的 delivery commit/discard 路径。只有 prompt 真正进入请求后才提交 revision 和 telemetry；取消、构建失败或未发送时必须 discard。
- 测试：ACP 连续三个 UserQuery，revision 不变时 Complete Tree 只出现一次；revision 变化时只追加一次新树；发送失败不推进 revision。
- 涉及：`packages/cli/src/acp-integration/session/Session.ts`、`packages/core/src/core/client.ts` 及对应测试。

### P0.2 ToolResult 微压缩必须先于 Focused Subtree 渲染

- Thread：[R3867105677](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105677)
- 问题：ToolResult 路径先按旧历史渲染 `[内容已在当前上下文]`，随后 microcompact 删除对应 `search_memory` 正文，最终请求携带错误占位。
- 修复：在 ToolResult 消费 recall 前完成 size-only microcompact，并先把被清除正文同步到 MemoryManager；然后再生成 Focused Subtree。
- 测试：历史超过阈值且正文仅存在于旧 `search_memory` 结果时，发送历史包含 cleared marker，Focused Subtree 不得显示 resident marker，并允许再次 fetch。
- 涉及：`packages/core/src/core/client.ts`、`packages/core/src/core/client.test.ts`。

### P0.3 Dream runtime manifest 禁止删除 pinned 文件

- Thread：[R3867105681](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105681)
- 问题：`applyDreamOperations()` 可以直接 unlink `pinned/*.md`，绕过已有工具层 pinned 保护。
- 修复：manifest 路径验证阶段拒绝顶层 `pinned/` 下的 delete、dedupe source/target 和 split source/target。保护必须位于 runtime executor，不能只依赖 prompt。
- 测试：预置删除、dedupe、split 指向 pinned 文件的 manifest，全部拒绝且文件保持不变；`pinned-notes/` 等普通目录不误伤。
- 涉及：`packages/core/src/memory/dream-operations.ts` 及测试。

### P0.4 Dream 启动前删除遗留 manifest

- Thread：[R3867105689](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105689)
- 问题：进程硬退出后遗留的 `.dream-operations.json` 可能被下一次 planner 的 no-op 运行执行。
- 修复：Project Dream 和 User Dream 在持有对应 Dream lock 后、获取 before snapshot 和启动 planner 前执行 `rm(manifestPath, { force: true })`。保留现有 apply `finally` 和异常清理。
- 测试：预置旧删除 manifest，本轮 planner 不生成 manifest，旧目标必须存活；Project/User 两条路径都覆盖。
- 涉及：`packages/core/src/memory/dream.ts`、`packages/core/src/memory/user-dream.ts` 及测试。

### P0.5 不存在的兼容 memory root 不得阻塞 structured 切换

- Thread：[R3867105693](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105693)
- 问题：默认布局中兼容的 `<project>/.qwen/memory` 可能不存在；扫描容忍 ENOENT，但索引重建仍尝试在其下写 `MEMORY.md`，导致 legacy -> structured 切换反复失败。
- 修复：`rebuildAutoMemoryIndexAtRoot()` 在 root 不存在时直接 no-op；不要为了空兼容 root 创建新目录。
- 测试：一个真实 root 加一个不存在兼容 root，准备和提交 recall transition 成功，不产生兼容目录。
- 涉及：`packages/core/src/memory/indexer.ts`、Config transition 测试。

### P0.6 `task_stop` 支持 migration task

- Thread：[R3867105700](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105700)
- 问题：MemoryManager 已支持取消 migration，但交互入口只允许 dream，用户拿到 migration task id 后无法停止。
- 修复：`task_stop` 允许 `dream` 和 `migration`，统一调用 `MemoryManager.cancelTask()`；extract 继续不可取消；同步修正文案和 not-running 错误类型。
- 测试：running migration 可取消、terminal migration 返回 not-running、extract 返回 not-cancellable、缺失 controller 返回 internal error。
- 涉及：`packages/core/src/tools/task-stop.ts` 及测试。

### P0.7 迁移拒绝 symlink root 和 root escape

- Thread：[R3867105703](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105703)
- 问题：项目可提交 `.qwen/memory -> /outside`，自动迁移会读取、发送给模型并重写工作区外文件。
- 修复：扫描前验证迁移 root 本身不是 symlink；Project/Team root 的 realpath 必须位于各自允许边界。检查在读取任何正文之前执行。叶子继续使用现有 no-follow/CAS 写入。
- 测试：symlink root 指向外部目录时不扫描、不调用 metadata agent、不写文件、不重建外部索引；普通 root 正常工作。
- 涉及：`packages/core/src/memory/metadata-migration.ts`、路径安全辅助能力及测试。

### P0.8 Grep 遵守 structured managed-memory 边界

- Thread：[R3867105705](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105705)
- 问题：`grep_search` 可绕过 `search_memory` 直接返回 managed-memory 正文。
- 修复：普通 structured 主模型的 Grep 搜索排除所有 managed-memory roots；`allowsDirectAutoMemoryRead() === true` 的 scoped Agent 保持可读。优先把现有路径能力判断接入 Grep，而不是新增另一套规则。
- 测试：同一 structured 配置下 capability false 不返回 managed memory、capability true 返回；普通仓库匹配始终正常。
- 涉及：`packages/core/src/tools/grep.ts` 及测试。

### P0.9 正确区分正文窗口截断和 ref 读取预算耗尽

- Thread：[R3867105709](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105709)
- 问题：关键词命中靠近 20K 可读上限时，返回不足 1K 字符却把整个 ref 标成 exhausted，导致同轮其他区域无法再读。
- 修复：exhausted 只表示该 ref 的累计本轮正文预算实际用完；窗口因可读 cap 截断但仍有未读区间时，不标记整条 ref exhausted。cursor 继续表达相邻窗口翻页。
- 测试：长正文在 500 和 19,500 两处包含不同关键词；先读后者后仍能搜索前者，只有累计达到预算后才过滤。
- 涉及：`packages/core/src/memory/search-memory.ts` 及测试。

### P0.10 Search keyword 验证支持完整 Unicode 文字

- Thread：[R3867105711](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105711)
- 问题：Search 只接受 ASCII 和 Han，日文假名、韩文、西里尔、希腊和阿拉伯关键词被拒绝，与 Recall tokenizer 不一致。
- 修复：复用 Recall 的 Unicode 字母和 CJK script 定义，保持现有最短长度、空白和标点约束。
- 测试：Han、Hiragana、Katakana、Hangul、Cyrillic、Greek、Arabic 均接受；纯标点、单字符噪声继续拒绝。
- 涉及：`packages/core/src/memory/search-memory.ts` 及测试。

### P0.11 Search scopes 在扫描前去重

- Thread：[R3867105717](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105717)
- 问题：`['project', 'project']` 会扫描两次并返回重复结果，挤掉其他候选。
- 修复：在 schema/runtime 校验后稳定去重 scopes，并让 `searchedScopes` 返回同一规范化数组。传入 snapshot 和实时扫描两条路径使用同一值。
- 测试：重复 scopes 与单一 scope 得到相同 refs、排序和 rarity 结果。
- 涉及：`packages/core/src/memory/search-memory.ts` 及测试。

### P0.12 ACP 每个新 UserQuery 重置 turn-local recall 状态

- Thread：[R3867105720](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105720)
- 问题：ACP 不调用 `resetExhaustedBodyRefsForCurrentTurn()`，使 exhausted refs 和 duplicate claims 变成 session 级永久状态。
- 修复：在 ACP 确认开始一个新的 UserQuery 时调用现有重置接口；ToolResult continuation 不重置。
- 测试：第一轮相同 search 重复被抑制，第二轮可重新执行；第一轮 exhausted ref 第二轮恢复可搜。
- 涉及：`packages/cli/src/acp-integration/session/Session.ts` 及测试。

### P0.13 User Dream 启用 pinned 写保护

- Thread：[R3867105727](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105727)
- 问题：User Dream 是唯一未传 `protectPinnedMemory: true` 的后台维护 Agent，可通过 write/edit 修改全局 pinned memory。
- 修复：User Dream scoped config 开启 pinned 保护，并补充与 Project Dream 一致的模型提示；runtime manifest 保护由 P0.3 单独兜底。
- 测试：User Dream 对 `pinned/preferences.md` 的 write/edit 被拒绝，普通 User Memory 仍可编辑。
- 涉及：`packages/core/src/memory/user-dream-agent-planner.ts` 及测试。

### P0.14 SearchMemory 结果不得被通用 scheduler 截坏

- Thread：[R3867105736](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105736)
- 问题：SearchMemory 返回结构化 JSON，但工具没有声明输出上限；通用 head/tail 截断后 JSON 无法解析，已读状态与历史实际内容永久不一致。
- 修复：SearchMemory 自己已经执行正文预算，工具层声明 `maxOutputChars = Infinity`，避免 scheduler 二次破坏结构；同时保留 search/fetch 内部总预算。
- 测试：包含大量转义字符、序列化后超过默认 25K 的结果完整保留，可被 microcompaction parser 识别并在清除后允许重读。
- 涉及：`packages/core/src/tools/search-memory.ts`、scheduler/retention 相关测试。

### P0.15 Glob 尊重 direct-read capability

- Thread：[R3867105745](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105745)
- 问题：Glob 在 structured 模式无条件过滤 managed memory，Dream/Extraction 虽有 direct-read capability 仍看不到文件。
- 修复：过滤条件增加 `allowsDirectAutoMemoryRead() !== true`。不改变 recall mode 和文件过滤的其他行为。
- 测试：structured + capability false 隐藏；structured + capability true 可见；legacy 行为不变。
- 涉及：`packages/core/src/tools/glob.ts` 及测试。

### P0.16 Shell gate 必须检查 cwd 本身

- Thread：[R3867105752](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105752)
- 问题：当 `directory` 已经位于 managed root 时，`cat MEMORY.md`、`rm preference.md` 等裸文件名绕过 token 路径检查。
- 修复：在命令 token 扫描前检查 resolved cwd 是否位于 managed root。普通 structured 主模型拒绝；同时具备 direct read/write capability 的 scoped Agent继续允许。
- 测试：Project/User/Team root 下分别覆盖 bare read、write、delete；普通仓库 cwd 不误伤；scoped Agent 正常。
- 涉及：`packages/core/src/tools/shell.ts` 及测试。

## 5. P0 邻接问题：应随能力边界修复一并处理

### P0.A `read_many_files` / folder structure 的 managed-memory 隐藏不完整

- Thread：[R3867105961](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105961)
- 当前 review 标为 Suggestion，但它与 P0.8、P0.15、P0.16 属于同一已声明的 structured 访问边界。
- 问题：从 `.qwen` 或 managed root 内部开始列举时，root-aware 过滤失效，可暴露物理目录和正文。
- 处理建议：本 PR 一并修复。使用绝对路径和 managed-root containment 判断；目录本身位于 managed root 时不渲染其内容。direct-read scoped Agent 是否通过该入口读取，必须与现有 API 的调用场景保持一致。
- 测试：列出 workspace root、`.qwen`、managed root、managed 子目录四种起点，均不泄露；普通目录不受影响。

### P0.B 统一工具能力矩阵

完成 P0.8、P0.15、P0.16 和 P0.A 后，必须验证以下矩阵，不再为不同工具维护互相冲突的语义：

| 调用者              | Read            | Glob            | Grep            | LS/Folder       | Shell                            |
| ------------------- | --------------- | --------------- | --------------- | --------------- | -------------------------------- |
| Legacy 主模型       | 保持原行为      | 保持原行为      | 保持原行为      | 保持原行为      | 保持原行为                       |
| Structured 主模型   | 拒绝/隐藏       | 隐藏            | 排除            | 隐藏            | 拒绝                             |
| Memory scoped Agent | capability 控制 | capability 控制 | capability 控制 | capability 控制 | capability + tool allowlist 控制 |
| Generic subagent    | 不自动授权      | 不自动授权      | 不自动授权      | 不自动授权      | 不自动授权                       |

## 6. P1：45 条 Suggestion 的分类与处理

Suggestion 不因标签较低而自动延期。以下“直接解决”项纳入当前 PR；只有无法证明当前行为错误、属于产品文案偏好或会引入无关重构的意见才列为 No action。

### 6.1 直接解决：关键测试缺口

- [x] [R3867105759](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105759)：补 `/memory migrate-team` disabled 和 untrusted 负向测试。
- [x] [R3867105766](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105766)：补 `runForkedAgent` FINISH usage 转发测试。
- [x] [R3867105768](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105768)：补 Config recall mode 初始化与 prepare/confirm/commit/rollback 生命周期测试。
- [x] [R3867105775](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105775)：用非空 `evictedMemoryBodies` 固定 compress-fast 转发契约。
- [x] [R3867105782](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105782)：恢复 legacy surfaced-path 排除的 client 级测试。
- [x] [R3867105787](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105787)：补 structured -> `hideManagedMemory=true` 测试。
- [x] [R3867105788](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105788)：补 Dream 成功路径 manifest finally 清理测试。
- [x] [R3867105799](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105799)：分别验证 Project/User Dream 的 `migration_pending` scope 独立性。
- [x] [R3867105805](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105805)：覆盖 extract、memory tool、forget 触发 User mutation 以及 User Dream manager 生命周期。
- [x] [R3867105820](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105820)：补多文件触发 40K migration body budget 的测试。
- [x] [R3867105825](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105825)：补 agent reject/AbortError 进入 catch 分支并重建已提交索引的测试。
- [x] [R3867105843](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105843)：补 legacy heuristic fallback 的 excluded paths 和 active-tool noise 测试。
- [x] [R3867105857](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105857)：验证 project-only Remember 不记录 User mutation。
- [x] [R3867105908](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105908)：补 Focused Subtree 超预算省略、footer 和 displayed=0 测试。
- [x] [R3867105929](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105929)：补 User Dream `document_limit` 触发和完成后仍超限测试。
- [x] [R3867105951](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105951)：补 memory pressure compaction 的真实 body eviction 转发测试。
- [x] [R3867105958](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105958)：固定 `logMemorySearch` 格式、attributes 和隐私约束。
- [x] [R3867105965](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105965)：补 User/Team roots 的 Shell gate 测试；若 P0.16 已覆盖，则在原 thread 说明并 resolve。

这些测试不独立形成大范围测试重构。实现对应 P0/P1 行为时，直接加入最小 witness：删除修复代码后测试必须变红。

### 6.2 直接解决：真实行为和协议问题

- [x] [R3867105763](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105763)：让 migration task 在现有 memory status/background task surface 中可见，至少能查看 completed/failed/cancelled 和错误摘要；不新建任务 UI。
- [x] [R3867105773](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105773)：避免 structured 稳态每个 UserQuery 完整读取和 hash 全 corpus。复用已知 revision/dirty 信号建立快速 no-op；外部变更仍需在现有刷新边界被发现。
- [x] [R3867105804](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105804)：把 migration domain 的 in-flight 检查移到 corpus 全扫描之前；ready/structured 稳态不再无条件调度迁移扫描。与 R3867105773 使用同一最小状态，不增加第二套 cache。
- [x] [R3867105817](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105817)：区分 Dream 内容整理失败和 completion metadata 持久化失败。内容已经成功提交时不得回滚为“未执行”并重复运行；记录可诊断的 metadata persistence error。
- [x] [R3867105827](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105827)：迁移扫描逐文件隔离 ENOENT/并发删除等可恢复错误，保留已提交统计；权限错误和根目录安全错误继续使对应 scope 明确失败，不能静默 ready。
- [x] [R3867105848](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105848)：structured body-only noise suppression 与 tokenizer 的 Han/Kana/Hangul 定义一致，避免非 Han CJK body-only 文档误入 Fast。
- [x] [R3867105853](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105853)：短 Latin keyword 使用 token boundary，不能让 `ai` 命中 `explain`；identifier/完整 stored phrase 的强命中保持不变。
- [x] [R3867105861](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105861)：User Memory 写入成功后立即记录 User mutation，不依赖 Project index 重建成功；仍向调用者报告索引重建错误。
- [x] [R3867105867](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105867)：扫描只接收真实 regular `.md` 文件，忽略名为 `*.md` 的目录。
- [x] [R3867105874](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105874)：扫描排序增加稳定 `relativePath` tie-break，确保相同 mtime/basename 的 survivor 和索引稳定。
- [x] [R3867105878](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105878)：先合并同 scope 的多个 roots，再统一应用 `MAX_SCANNED_MEMORY_FILES`，避免双 root 返回 2 倍 cap。
- [x] [R3867105896](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105896)：fetch snapshot 后文件消失时返回 `missingRefs` 和 warning，不静默漏掉请求 ref。
- [x] [R3867105916](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105916)：ref identity 使用无损相对路径编码，display sanitizer 只用于展示；扫描时检测冲突，保证每个文件可唯一 fetch。
- [x] [R3867105926](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105926)：User Dream vocabulary scan 失败时保留 best effort，但输出不含正文/路径的 degraded warning。
- [x] [R3867105944](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105944)：多 scope vocabulary 先识别有内容 scope，再公平分配总预算，保证每个请求 scope 至少有一段可见；不把总预算按 scope 倍增。
- [x] [R3867105961](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105961)：`read_many_files` managed-memory 泄露按 P0.A 修复。
- [x] [R3867105971](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105971)：tool registry 改用 `ToolNames.SEARCH_MEMORY/MANAGE_MEMORY`，缺失 recall-mode getter 时回退 `legacy`，与 Config 默认一致。

### 6.3 直接解决：确定性简化和死代码

以下项只做删除或改用已有常量，不引入新行为：

- [x] [R3867105796](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105796)：删除无人读取的 `AutoMemoryExtractResult.touchedProjectScope`。
- [x] [R3867105811](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105811)：删除无生产调用者设置的 `minHoursBetweenDreams`。
- [x] [R3867105888](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105888)：删除未参与任何决策的 cursor `depth`，保留 next/previous cursor 的真实窗口语义。
- [x] [R3867105912](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105912)：删除 Global Router 不可达的 non-compact 分支和未执行的 `charBudget` 选项。
- [x] [R3867105936](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105936)：删除未使用的 `runManagedUserAutoMemoryDream(now)` 参数。
- [x] [R3867105939](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105939)：删除无人设置的 vocabulary `maxChars` 选项，直接使用默认总预算。
- [x] [R3867105941](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105941)：删除被前置“禁止所有点号”规则覆盖的扩展名检查；本 PR 不顺带改变 dotted keyword 策略。

### 6.4 No action：当前没有必要修改

- [x] [R3867105835](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105835)：保留 corpus status 的 `files/legacyFiles/legacyByScope`。它们用于迁移诊断、E2E 验证和 scope 问题定位，删除只减少少量对象字段，却会削弱这次迁移的可观测性。
- [x] [R3867105839](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105839)：不把 migration agent 的 config overlay 重构为 `deriveConfig()`。当前调用没有触发 mutator，review 也未证明实际错误；替换属于架构重构，会扩大本 PR 风险。
- [x] [R3867105922](https://github.com/QwenLM/qwen-code/pull/10183#discussion_r3867105922)：不因语言风格统一修改 Focused Subtree 文案。中英混用没有造成协议错误，且提示词变化需要单独评测，不在 correctness 收尾中顺带调整。

以上 No action 项需要在原 inline thread 说明理由并 resolve，不创建模糊的延期项。

## 7. 此前 review 中需要明确决策的遗留项

### 7.1 Headless migration 是否 drain

- 当前单轮 `qwen -p` 在进程退出时会取消仍在运行的迁移，不能保证大 corpus 在一次 headless 调用中完成。
- 直接 `await drain()` 会延长退出并增加后台模型成本；自动 self-drain 会让迁移在没有新 UserQuery 时连续消费 API。
- 决策：当前 PR 不隐式改变成本模型。在 PR 描述中声明“迁移按完成 UserQuery 分批推进”；需要 idle continuation 时另开产品设计。

### 7.2 Selector manifest 25KB 预算

- `MAX_MODEL_MANIFEST_BYTES = 25_000` 仍可能在大 corpus 下减少 selector 候选数。
- 当前没有足够评测证明应采用的新预算，也不是 correctness 缺陷。
- 决策：保留现值，通过 telemetry 和大样本评测后单独优化。

### 7.3 Vocabulary 动态更新

- 迁移成功提交每一条后，当前 batch 内的 docs/vocabulary 已能吸收新 canonical phrases。
- 多 scope 公平预算问题见 R3867105944，已纳入本 PR 直接解决。
- 不冻结 migration-start vocabulary。

## 8. 隔离迁移测试结论

测试目录：

```text
/Users/zhangzijian/workspace/qwen-code-loop/tmp/
memory-migration-real-chain-r6-20260826-173158/
```

### 8.1 已确认事实

- 测试在隔离目录运行。
- 真实 `~/.qwen/projects/.../memory` 未修改。
- 真实 `~/.qwen/memories` 未修改。
- 仓库真实 `.qwen/` 未新增 memory 子目录。
- 目录数量为 `feedback=11`、`project=46`、`reference=8`、`skills=1`、`user=4`。
- 前四组总计 66，剩余 `user/` 四条按路径排序位于最后。

### 8.2 对报告问题的判定

| 报告现象                             | 判定                 | 说明                                               |
| ------------------------------------ | -------------------- | -------------------------------------------------- |
| 66/70 complete                       | 真实但不是 scope bug | 最后一批尚未启动/完成                              |
| `user/*.md` 未由 User migration 处理 | 根因错误             | 它们位于 Project root，scope 仍是 project          |
| aggregate body hash 变化             | 测试方法无效         | 四个无 frontmatter 文件在迁移前被 awk 错算为空正文 |
| structured 未切换                    | 当前状态真实         | ready 必须等待最后四条迁移完成                     |
| 外部真实记忆被污染                   | 已排除               | 隔离证据通过                                       |

### 8.3 正确的后续验证

- [ ] 等待当前 migration batch settle。
- [ ] 再完成一次 UserQuery，触发最后四条 Project Memory 迁移。
- [ ] 使用生产 validator 确认 `legacyByScope.project=0`、`legacyByScope.user=0`。
- [ ] 再发送下一条 UserQuery，验证 legacy -> structured transition。
- [ ] 检查主模型上下文包含 Complete Tree 和 Focused Subtree，不再包含 managed `MEMORY.md` 平铺正文。
- [ ] 使用生产 frontmatter parser 逐文件计算 `relativePath + bodyHash`：合法 frontmatter 取 closing delimiter 后正文，无 frontmatter 取整个原文件。
- [ ] 验证修改前后每个文件的正文 bytes，而不是只比较一个 aggregate hash。

## 9. 已修复、已证伪或不应重新打开的问题

- Brace 跨路径段展开和 `.*` 递归 Shell 绕过已经修复并有回归测试。
- Node 22.0-22.4 缺少 `path.matchesGlob` 的问题已经通过改用 `picomatch` 消除，不需要提高 engines。
- 已废弃 Category Router/overview API 和 session body-read refs 死代码已经清理。
- `getUserAutoMemoryRoot()` 不应响应 `QWEN_CODE_MEMORY_LOCAL=1`；它表示跨项目 User Memory。
- Project root 下的 `user/*.md` 不应重分类为全局 User scope。
- 当前没有证据证明 metadata migration 修改了正文。
- Dream 已有 PID/mtime 跨进程锁；同 root 多 session 不会并发运行 Dream。被锁 session 返回 `locked`，不会自动排队接力。
- Structured Shell policy 不是禁用 Shell，而是阻止普通主模型绕过 managed-memory 协议；普通仓库文件和显式授权 scoped Agent 保持可用。
- 不重新引入自动连续 migration self-drain。
- 不把评测脚本、HTML、隔离语料或运行产物纳入 PR。

## 10. 实施批次

### 批次一：文件安全和 pinned 保护

- P0.3、P0.4、P0.7、P0.13。
- 验证 Dream operations、Project/User Dream、metadata migration focused tests。
- 目标：先消除不可恢复的数据删除和工作区逃逸风险。

### 批次二：工具能力边界

- P0.8、P0.15、P0.16、P0.A/P0.B。
- 验证 Read/Glob/Grep/LS/Folder/Shell capability matrix。
- 目标：使用同一 capability 语义收敛 structured 主模型与维护 Agent 行为。

### 批次三：上下文驻留和 ACP 生命周期

- P0.1、P0.2、P0.12、P0.14。
- 验证 ACP 连续轮次、ToolResult microcompact、SearchMemory JSON retention。
- 目标：保证“已在上下文”占位和实际历史一致。

### 批次四：SearchMemory 和迁移控制

- P0.5、P0.6、P0.9、P0.10、P0.11。
- 验证 index transition、task cancellation、长正文、多语言和重复 scope。

### 批次五：迁移、Dream 和稳态生命周期

- R3867105763、R3867105773、R3867105804、R3867105817、R3867105827、R3867105861。
- 复用同一套 dirty/revision 状态解决稳态重复扫描，不新增并行 cache。
- 验证 migration 可见性、in-flight 快速返回、User mutation 持久化顺序和并发文件消失。

### 批次六：召回质量和扫描确定性

- R3867105848、R3867105853、R3867105867、R3867105874、R3867105878、R3867105896、R3867105916、R3867105944、R3867105971。
- 验证多语言 body-only 噪声、短词边界、双 root cap、稳定排序、ref 唯一性和多 scope vocabulary 公平性。

### 批次七：最小清理和剩余测试 witness

- 完成 6.1 中尚未由前六批覆盖的关键测试。
- 完成 6.3 中只删除死字段、死参数和不可达分支的清理。
- 不处理 6.4 的 No action 项，不借清理进行命名或架构重构。

每个批次完成后：

1. 运行本批次涉及的 focused tests。
2. 运行 Core/CLI 对应 package typecheck。
3. 阅读本批次完整 diff，确认没有顺带重构。
4. 提交一个 Conventional Commit。
5. 在对应 inline threads 回复修复和测试证据，然后 resolve。
6. push 后确认 PR head、merge conflict 和 CI 状态。

## 11. 最终验证

- [ ] 所有 P0 focused tests 通过。
- [ ] `npm run build` 通过。
- [ ] `npm run typecheck` 通过。
- [ ] Core 和 CLI 修改文件对应单测通过。
- [ ] 隔离 migration 从 70 legacy 自然推进到 structured。
- [ ] 逐文件 body bytes 保持一致。
- [ ] ACP 连续会话不重复 Complete Tree，不保留跨轮 exhausted state。
- [ ] 压缩后 resident marker 与历史实际正文一致，允许重新 fetch。
- [ ] Project/User/Team managed-memory roots 的能力矩阵全部通过。
- [ ] Dream manifest 无法修改 pinned 或执行上一轮操作。
- [ ] Symlink root 不读取、不发送给模型、不写外部文件。
- [ ] PR 无 merge conflict，CI 通过。
- [ ] 16 条 Critical 全部以当前 HEAD 验证、回复并 resolve。
- [ ] 45 条 Suggestion 分别完成“直接解决”或给出可验证的 No action 理由；没有必要项留在模糊 follow-up 中。

## 12. 完成标准

只有同时满足以下条件，PR 才进入可合并状态：

1. 16 条 Critical 均有代码或明确的当前 HEAD 反证，并在原 thread 闭环。
2. 不存在 pinned data loss、路径逃逸、managed-memory 访问绕过和虚假正文驻留状态。
3. Legacy 用户可继续工作，完整迁移后能可靠切换 structured。
4. 必要 Suggestion 已直接解决；No action 仅限没有当前错误证据的架构重构和提示文案偏好。
5. 验证结果基于真实代码路径和 focused regression tests，而不是仅依赖 prompt 或 aggregate shell hash。
