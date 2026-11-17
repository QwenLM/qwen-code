# Session Artifact 创建与更新生命周期

[English](artifact-create-update-lifecycle.md) | [简体中文](artifact-create-update-lifecycle.zh-CN.md)

- 状态：实现中（PR 1）
- 日期：2026-10-15
- 关联 issue：[#14282](https://github.com/QwenLM/qwen-code/issues/14282)
- 相关设计：[session-artifacts-persistence-v2-design.md](session-artifacts-persistence-v2-design.md)、[session-artifacts-directory-expansion.md](../session-artifacts-directory-expansion.md)、[web-shell-tool-file-preview.md](../web-shell-tool-file-preview.md)

## 1. 背景与问题

当前 artifact 基本是"新建时登记一次"的模型：`write_file` 写出特定扩展名的文件时自动登记，其余情况依赖模型主动调用 `record_artifact`。常见场景因此落空：

- 用户上传一个文件到工作区，让 AI 修改；AI 用 `edit` 修改，不产生 artifact，产物区找不到这个文件。
- 已登记的产物被后续 `edit` 修改时不重设基线；之后列表刷新把它标成 `changed`，agent 自己的修改看起来像外部篡改。
- 一个文件先由 `write_file` 创建、再由 `edit` 修改时，产物仍停留在创建它的 turn，修改它的 turn 里看不到。

业务侧如何把非文件资源（例如数据表）登记为 artifact，不在本设计范围内；qwen-code 只需保证工作区文件的创建/更新链路可靠。

## 2. 现状（基于 `main` 已核实）

### 2.1 链路

```text
工具 ToolResult.artifacts
  → 写入 transcript 的工具结果（record.metadata.artifacts）
  → ACP tool_call_update._meta.artifacts          (cli: tool-call-emitter.ts)
  → bridge extractSessionUpdateArtifacts          (acp-bridge: bridgeClient.ts；按字段白名单透传，转发给客户端前剥离 _meta.artifacts)
  → SessionArtifactStore.upsertMany               (acp-bridge: sessionArtifacts.ts；串行 mutation 队列)
      expandWorkspaceDirectoryInput → normalizeInput（stat + hash，建立 qwen.workspace.* 基线）
      → 不存在则 created；存在则归属检查 → mergeArtifact → 公开字段有变化则 updated
  → artifact_changed SSE → web-shell 全量刷新列表
```

其他入口：PostToolUse hook 的 `hookSpecificOutput.artifacts`、客户端 `POST /session/:id/artifacts`（带可信 `clientId`）、slash 命令的 `_meta.sessionArtifacts`。

### 2.2 哪些工具会产出 artifact

| 工具                                 | 是否产出 | 说明                                                                                                                                                     |
| ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_file`                         | 部分     | 仅 `ARTIFACT_KIND_BY_EXTENSION` 中的扩展名（`.csv/.htm/.html/.ipynb/.jpeg/.jpg/.pdf/.png/.svg/.webp` 和 office 文档）；`record_as_artifact=false` 可关闭 |
| `record_artifact`                    | 是       | 模型显式调用                                                                                                                                             |
| `artifact` / `image_gen` / omni 工具 | 是       | 发布型 HTML、生成图片、媒体派生物                                                                                                                        |
| `edit`（包括用 edit 新建文件）       | 否       | 所有返回路径都只有 `llmContent` + `returnDisplay`                                                                                                        |
| `notebook_edit`                      | 否       | 无任何 artifact 引用                                                                                                                                     |
| `run_shell_command` / MCP 工具       | 否       | 本设计不处理（见第 6 节）                                                                                                                                |

### 2.3 Store 语义

- 身份：`stableSessionArtifactId(sessionId, 'workspace:<canonicalPath>')`，同一路径即同一个 artifact。
- 基线：`normalizeInput` 在队列内 stat 并 hash 文件，写入 `qwen.workspace.sha256 / mtimeMs / sizeBytes`；list/get 按 5 秒 TTL 懒刷新，实时内容偏离基线即置 `changed`，**不发布事件**。没有指纹基线的条目在刷新时会把当前内容直接写成基线。
- 基线只来自 store 自己的读取：`normalizeMetadata` 剔除输入里的 `qwen.workspace.*` 键；实时 `upsertMany` 调用 `normalizeInput` 时不传 `workspaceExpected`，只有 restore 路径用已持久化的指纹作为期望值。写入与登记之间的外部改动会被直接吸收为基线。
- 归属：`denyCrossClientMutation` 拒绝对 `source: 'client'` 且带 `clientId` 的条目做不同 `clientId` 的 upsert。工具来源的输入不带 `clientId`，因此**宿主登记的文件被 agent 修改后的 upsert 会被拒绝**。
- 合并：`mergeArtifact` 中 `status`、`sizeBytes` 取本次输入；`mergeMetadata` 在 `incoming.source !== existing.source`（或来源为 hook）时保留旧 metadata，**不采纳新指纹**。
- 展示字段（`title`、`description`、`toolCallId`、`toolName`、`source`、`hookEventName`）只在 `shouldRefreshWorkspaceDisplay` 为真时刷新：`record_artifact`（非 hook）、无 `toolName` 的登记，或 `toolName` / `source` / `hookEventName` **三者都相同**。注释明确要求自动登记不得覆盖用户可见标题。
- 删除：`shouldSuppressTombstonedUpsert` 只阻止 client 来源复活；被用户删除的 tool / hook 产物，下一次同路径登记会重新创建。
- 驱逐：超过 200 条时依次淘汰最老的 missing 条目、超出来源配额的条目、最老的非 `clientRetained` 条目。如果剩下的全都是 `clientRetained`，最后一档会淘汰其中最老的一条。
- "文件消失即遗忘"（`isVanishedAutoRecordedWorkspaceArtifact`）和存在性复查（`shouldRecheckWriteFilePresence`）都写死 `toolName === 'write_file'`。

### 2.4 Web Shell

- `canDownloadArtifact` 已同时接受 `available` 和 `changed`，`ArtifactPanel` 对两者的预览一致，并有测试覆盖。缺的只是 `changed` 的提示。
- turn 归属（`getArtifactsByTurn`）：先匹配 `record_artifact` 参数和 `reportedArtifacts` 中的路径；**只有一个都没匹配上时**，才按 `artifact.toolCallId` 归属到一个 turn。

### 2.5 `ToolResult.artifacts` 的下游消费方

| 消费方                                                           | 行为                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| bridge 实时摄入（`sessionUpdate` → `upsertAndPublishArtifacts`） | 写入 artifact store                                                                         |
| transcript 记录与 `session/load` 回放（`transcript-replay.ts`）  | 工具结果原样持久化；没有 artifact 快照或快照恢复失败时，`seedSessionUpdates` 按顺序重新摄入 |
| `toolResultBoundaryArtifact`                                     | 只统计 artifact 的 kind，用于诊断                                                           |
| managed runtime provider 协议                                    | 超出大小上限时丢弃 `artifacts`                                                              |
| media policy 收集                                                | 只对带 `mediaPolicyDescriptor` 的工具生效；`write_file` / `edit` / `notebook_edit` 都没有   |

### 2.6 问题清单

| #   | 问题                                                                    | 后果                                                                  |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| G1  | 只有 `write_file` 自动登记，`edit` / `notebook_edit` 不登记             | 上传后被修改的文件、用 edit 新建的文件找不到                          |
| G2  | 已登记产物被 `edit` 修改时，没有任何 upsert                             | 不重设基线、不发事件；之后被标成 `changed`                            |
| G3  | `mergeMetadata` 跨 source 不采纳指纹                                    | hook 或匿名 client 登记的产物被工具改写后，仍回到 `changed`           |
| G4  | 带 `clientId` 的宿主登记拒绝工具 upsert                                 | 宿主登记的文件被 agent 修改后不同步，变成 `changed`                   |
| G5  | `shouldRefreshWorkspaceDisplay` 要求 `toolName` 相同才推进 `toolCallId` | `write_file` 创建、`edit` 修改时，产物停在创建的 turn（由评论者指出） |
| G6  | Web Shell 有 `record_artifact` 引用时不看 `toolCallId`                  | 即使推进 `toolCallId`，显式登记过的产物也不会出现在修改它的 turn      |
| G7  | 遗忘/复查规则写死 `write_file`                                          | 由 `edit` / `notebook_edit` 创建的产物无法被正确遗忘或复查            |
| G8  | 用户删除的 tool 产物会被下一次登记复活                                  | `edit` 自动登记后会频繁发生                                           |

## 3. 目标与非目标

目标：

1. Agent 用 `write_file` / `edit` / `notebook_edit` 在工作区内**创建或修改**的交付物，按同一策略进入 artifact 列表。
2. Agent 修改**已登记**的文件（任意扩展名、任意登记来源，包括带 `clientId` 的宿主登记）时，同一 id 发 `updated`，内容基线同步，状态保持 `available`。宿主登记的标题、retention 与归属不变。
3. 产物出现在最近一次修改它的 turn。
4. 已有会话里的 artifact 安全共存：身份规则不变，不迁移、不扫盘、不批量重置。

非目标：

- 不新增扩展名配置项；内置集合只追加 4.2 列出的四个扩展名。白名单之外的源码（如 `.ts`）被修改时不新建 artifact。
- 不做 revision 轨迹、内容快照、shell 产物检测（拆为独立 issue，见第 6 节）。
- 不覆盖远程 execution worker 内的文件。

## 4. 方案

### 4.1 生命周期规则

| 事件                                                   | Store 行为                                                    | status    | 事件              |
| ------------------------------------------------------ | ------------------------------------------------------------- | --------- | ----------------- |
| Agent 写入匹配策略且未登记的文件                       | 新建，建立基线                                                | available | created           |
| Agent 写入**已登记**的文件（任意扩展名、任意登记来源） | 更新，同步内容基线，`toolCallId` 推进到本次调用               | available | updated           |
| Agent 写入未登记且不匹配策略的文件                     | 忽略（不 stat、不 hash）                                      | –         | –                 |
| Agent 写入**被用户删除过**的路径                       | 按 `updateOnly` 处理，不复活；显式 `record_artifact` 仍可重建 | –         | –                 |
| 写入后、登记前文件又被改动                             | 与今天一致，被吸收为基线（见 4.3）                            | available | created / updated |
| `write_file` 写入与原内容相同的内容                    | 与普通写入相同处理（不比较内容）                              | available | created / updated |
| 真正的 no-op edit / 写入失败                           | 不产生候选                                                    | –         | –                 |
| 用户或其他方式修改（包括 agent 的 shell 命令）         | 懒刷新时发现                                                  | changed   | 无（不变）        |
| 文件被删除                                             | 自动登记的产物被遗忘；显式登记的标为 missing                  | missing   | removed / 无      |
| `write_file` 设置 `record_as_artifact=false`           | 只阻止新建；已登记的产物仍同步                                | –         | –                 |

语义：`changed` 只表示"偏离了最近一次 agent 文件工具写入的内容"。

### 4.2 共享自动登记策略

把 `write-file.ts` 中的扩展名映射、工作区路径解析、跳过目录、展示安全检查、MIME/kind 推断抽到 `packages/core/src/tools/artifact/workspace-auto-record.ts`。`write_file`、`edit`（含新建）、`notebook_edit` 在**写入成功提交之后**调用：

- 返回 `null`：artifact 功能关闭、不在工作区、位于跳过目录、路径或标题不安全。
- 匹配内置扩展名：返回普通候选。
- 不匹配，或 `record_as_artifact=false`：返回 `updateOnly: true` 的候选。

内置扩展名集合在现有基础上追加 `.sql`、`.py`、`.md`、`.json`，kind 均为 `file`。它们是数据与分析场景最常见的交付物；不做成配置项，是为了不引入新的 settings 面。现有的跳过规则（点目录、`node_modules`、`dist` 等）继续生效。`write_file`、`edit`、`notebook_edit` 上的 `record_as_artifact=false` 不新建产物；该路径上会话里已经有的产物仍会刷新。artifact 登记出错不得让一次成功的文件写入变成失败的工具调用：构造候选只做路径解析（realpath 失败时退回字面路径），store 在工具结果返回之后才登记。只有内置扩展名的候选在 `llmContent` 追加提示，`updateOnly` 候选不追加。

### 4.3 入站字段：`updateOnly`

```ts
interface ToolArtifact {
  // ...existing
  /** 只刷新会话里已有的 artifact，从不新建。 */
  updateOnly?: boolean;
}
```

- 该字段要在 `bridgeClient.ts` 的 `artifactPayloadFields` 白名单中显式加入，并加到 `SessionArtifactInput`，否则会被过滤掉。
- 它不进入 artifact 的 journal/snapshot，也不出现在公开 artifact 上；但会随工具结果写入 transcript。无快照回放时按原顺序重放，与今天的 `write_file` 一样，store 以当前文件内容为基线。

基线仍来自 store 自己的读取，工具不传期望指纹。早期草案曾加入 `expectedSha256`（工具写出字节的 hash），让写入与登记之间的改动保持 `changed`；现已去掉：daemon 模式下 bridge 声明了 `fs.writeTextFile` 客户端能力，agent 的写盘经 ACP 委托给 bridge 的文件系统适配器，agent 手里没有最终落盘的字节，主路径上这个字段会一直缺失。由 store 读取磁盘字节，还意味着工具保留编码的文件（GBK、UTF-8 BOM、CRLF）无需工具侧处理即可保持 `available`。代价是写入与 store 读取之间那个很短的窗口内发生的改动会被吸收为基线，与今天完全一致。

### 4.4 Store 改动（`sessionArtifacts.ts`）

自动登记生产者集合为 tool 来源的 `{write_file, edit, notebook_edit}`。

1. **`updateOnly` 先短路**：在串行队列内、`expandWorkspaceDirectoryInput` 之前，用与 `normalizeInput` 相同的路径规范化算出身份，并按 `upsertMany` 相同的查找方式（先 id，再 published workspace 目标）检查是否存在；不存在则直接丢弃——不建、不删、不驱逐、不发布、不 stat/hash，并写 `action=dropped reason="unmatched workspace update"`。存在时走正常的 `normalizeInput`。
2. **只同步内容（跨归属）**：来自生产者集合的输入跳过 `denyCrossClientMutation`，因此带 `clientId` 的 client 登记会接受 agent 的写入。合并只改内容字段：指纹基线、`status`、`sizeBytes`、`toolCallId`。`title`、`description`、`source`、`clientId`、retention、`clientRetained` 一律不变：`mergeArtifact` 保留已有的 `source` 与归属，展示刷新规则不接受该工具名，`mergeRetention` 不会覆盖显式 retention。其他工具输入（如 `record_artifact`，或带着生产者 `toolName` 的 hook 输入）仍被拒绝。这是已经接受的权限边界。
3. **跨 source 采纳指纹**：对生产者集合的输入，`mergeMetadata` 采纳 `isAdoptableContentFingerprintKey` 的键时不再要求 source 相同，且不新增其他键；其他输入、hook 来源输入、发布者信任规则不变。
4. **按文件身份推进 turn 归属**：把"推进 `toolCallId`"与"刷新标题/描述"拆开。生产者集合的输入合并到 workspace 条目时，`toolCallId` 推进到本次调用；`title`、`description`、`toolName`、`source`、`hookEventName` 仍按现有 `shouldRefreshWorkspaceDisplay` 规则，自动登记不得覆盖用户可见标题。`toolName` 保留创建者，使遗忘规则仍按"谁创建"判定。
5. **删除后不复活**：生产者集合的非 `updateOnly` 候选命中 tombstone 时，按 `updateOnly` 处理（因不存在而丢弃）。显式 `record_artifact`、hook 与客户端登记的复活规则不变。
6. **泛化遗忘/复查谓词**：`toolName === 'write_file'` 改为 `toolName ∈ {write_file, edit, notebook_edit}`，与今天一样不判断 source。因此 `toolName` 落在这个集合里的 hook 条目，文件消失时会被遗忘，和今天的 `write_file` hook 条目一样；这些条目在每次 list/get 时都会重新 stat，不受 5 秒存在性 TTL 保护。client 登记和显式 `record_artifact` 保留各自的 `toolName`，行为不变。

不采用的替代做法：让 `edit` / `notebook_edit` 伪装成 `toolName: 'write_file'`（耦合到一个不真实的名称）；整体放宽 `shouldRefreshWorkspaceDisplay`（会让自动登记覆盖用户标题）。

### 4.5 Web Shell（第一个实现 PR 内）

- 不改下载规则（`changed` 已可下载）。
- `changed` 卡片的 meta 行增加"登记后已被修改"提示（不写"会话外"，因为 agent 的 shell 命令也会造成 `changed`）。现有测试已固定 `changed` 可下载的行为。
- `getArtifactsByTurn`：对 workspace 产物，在 `record_artifact` / `reportedArtifacts` 匹配之外，**同时**加入 `artifact.toolCallId` 所在 turn（目前只在没有匹配时才用）。显式登记过的文件因此也会出现在最近一次修改它的 turn；对今天的条目，`toolCallId` 与登记调用在同一 turn，结果不变。published 与 link 产物的 `toolCallId` 不随后续写入推进，保持旧规则。不改 `artifactsByTurn` 类型。

### 4.6 上传文件

- 上传到工作区后被 agent 修改的文件：匹配内置扩展名（含新增的 `.sql`、`.py`、`.md`、`.json`）时，第一次修改即由 4.2 新建，宿主无需在上传时额外登记。
- 内置集合之外的类型：agent 修改它们不会新建 artifact；只有在已经以其他方式登记过时，才会经 `updateOnly` 同步。
- 只上传、未被修改的文件是输入，qwen-code 不主动登记。

### 4.7 对已有 artifact 的兼容性

**不需要数据迁移，不会扫盘补登记，不改已有 artifact 的 id。** artifact 持久化仍为 V2 journal/snapshot，不新增持久化字段。

| 场景                                              | 升级后行为                                                                                                                               | 处理                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 已有 artifact，升级后无人再改                     | 与今天一致                                                                                                                               | 无                                                    |
| 工作区里从未登记过的文件                          | 不会被补登记                                                                                                                             | 只有 agent 再次写入（且匹配策略）或显式登记才可能新建 |
| 已有会话中的 `.sql/.py/.md/.json` 文件            | 不补登记；升级后 agent 再次修改时才新建                                                                                                  | 默认值放宽带来的预期行为变化                          |
| 已有 artifact 被 agent 再次修改                   | 同一 id 发 `updated`，同步基线，`toolCallId` 推进                                                                                        | 这是修复                                              |
| 已经是 `changed` 的旧条目（多为过去 edit 未同步） | 保持 `changed`（可下载），直到下次 agent 写入                                                                                            | **不批量重置**：无法区分旧缺陷与真实外部修改          |
| 宿主（带 `clientId`）登记的产物                   | agent 修改时只同步内容；标题、retention、归属、tombstone 不变                                                                            | 已在 4.4 第 2 步接受                                  |
| hook / `record_artifact` 登记的产物               | 身份、标题、retention 不变；agent 修改时采纳新指纹                                                                                       | 无                                                    |
| 用户删除过的 `write_file` 产物                    | **行为变化**：今天再次写入会复活，升级后不复活                                                                                           | 需要时用 `record_artifact` 显式重建                   |
| published / managed / link / external_url         | 生产者写入不会更新 published 条目，其内容字段保持冻结                                                                                    | 无                                                    |
| 旧 transcript 的无快照回放                        | id 不变。回放没有保存的指纹，会对当前文件重新求 hash 并写成基线，原先 `changed` 的条目会变成 `available`                                 | 这不是对已存快照的批量转换                            |
| core 与 acp-bridge 版本                           | 只支持 daemon 与 agent 来自同一次安装。`QWEN_CLI_ENTRY` 可以指向另一份代码；拆开安装不受支持，旧 bridge 会丢掉 `updateOnly`              | 不要拆开安装                                          |
| 旧 web-shell + 新 daemon                          | 没有「登记后已被修改」提示。daemon 仍会推进 `toolCallId`，旧壳的回退只把卡片放在最近一次写入的 turn，不会同时出现在登记 turn 和修改 turn | 无                                                    |

实现与评审必须保持的约束：

1. 身份键不变：`workspace:<canonicalPath>`（及 managed/url）。
2. 不扫盘、不 backfill。
3. 升级或快照恢复时，不批量把已存的 `changed` 改成 `available`。无快照回放没有保存的指纹，会把当前文件写成基线。
4. `updateOnly` 永不删除或驱逐已有条目。
5. 跨归属只同步内容字段，不改标题、retention、归属。
6. 契约测试：用升级前写下的 V2 snapshot restore，断言条数与 id 不变；对其中一条 `edit`，断言同一 id、动作为 `updated`；另一条未触碰但已被外部修改的条目仍为 `changed`。

## 5. 分期

### 5.1 PR 1：一致的创建/更新（本设计主体）

- core：共享策略模块；`write_file` 改为调用它；`edit`、`notebook_edit` 返回 artifacts；`ToolArtifact.updateOnly`；工具描述同步。
- acp-bridge：白名单透传新字段；`updateOnly` 短路；跨归属只同步内容；跨 source 指纹采纳；`toolCallId` 按文件身份推进；删除后不复活；遗忘/复查谓词泛化。
- web-shell：`changed` 提示、workspace 产物的 turn 归属并入 `toolCallId`，以及回归测试。
- 测试：三个工具与策略模块的单测；bridge 透传 `updateOnly`；store 覆盖 `updateOnly`（未知丢弃且不 stat、已知更新）、跨 source 与跨归属同步且标题/retention/归属不变、`write_file` 建 + `edit` 改后 `toolCallId` 推进且标题不变、删除后不复活、由 `edit` 与 `notebook_edit` 创建的产物被遗忘、并发排队更新；V2 兼容契约测试。

默认扩展名追加四项，不加配置，PR 本身即可独立交付价值。

### 5.2 后续 PR：按 turn 展示多次修改

在现有基于 transcript 的引用分组上，纳入已完成的 `write_file` / `edit` / `notebook_edit` 输出路径，与权威 artifact 列表按规范路径匹配；同一产物在每个修改它的 turn 显示，turn 内去重，后续出现带"已更新"标记。由 transcript 派生，刷新与回放后不坍缩到最新 `toolCallId`，**不改 store 数据模型**。卡片展示当前内容，不代表历史快照。

## 6. 拆分出去的范围（单独开 issue）

- 每个 artifact 的有界 revision 轨迹（工具调用、hash、大小）及 revision 内容快照。
- 前台 shell 命令创建/修改文件的检测与归因。
- MCP 工具结果 `_meta` 的 artifacts 映射。

## 7. 风险

- **把每次写入都当成新产物**：由"内置策略之外一律 `updateOnly`"约束，并有测试覆盖。
- **编码场景噪音与驱逐**：新增的 `.md`、`.json`、`.py` 在普通编码会话里很常见（README、`package.json`、源码），被 agent 修改后都会成为 artifact。200 条上限不是缓解而是风险本身：超限后最老的非 `clientRetained` 条目被淘汰；如果剩下的全都是 `clientRetained`，其中最老的一条也会被淘汰。缓解：跳过目录规则不变；`write_file`、`edit`、`notebook_edit` 上的 `record_as_artifact=false` 可以不新建；删除后不复活。这是放宽默认值而非新增配置的代价，评审时需确认可接受。
- **含凭据的文件**：新增扩展名也会命中 `certs/service-account.json`、`config/credentials.json` 这类文件（包括被 gitignore 的），现有跳过规则都不排除它们。登记只在会话内列出路径、标题、大小和指纹；这条路径不复制也不上传内容，预览与下载走会话本来就能读取的工作区文件路由。不增加按文件名的跳过规则；`record_as_artifact=false` 可逐次关闭。
- **权限边界**：跨归属内容同步绕过了 `denyCrossClientMutation`。范围限定为生产者集合的 tool 输入和内容字段，并有测试固定不改标题、retention、归属。
- **写入到登记的窗口**：agent 写入与 store 读取之间的改动会被吸收为基线，与今天一致（见 4.3）。
- **性能**：未登记文件的 `updateOnly` 候选在 stat 之前短路；已登记文件每次修改 stat + hash（超过 100MB 的文件保持今天按大小建立基线的行为）。生产者集合创建的产物跳过 5 秒存在性 TTL，每次 list/get 都会 stat，所以文件被删后下一次 list 就会遗忘。无快照回放时，每条写入记录都会 hash 一次。
- **transcript 与诊断**：任何文件的每次 `edit` 都会在 transcript 工具结果中多一条候选记录（路径、标题、kind），`toolResultBoundaryArtifact` 的诊断也会多报 `file` kind。
- **journal 增长**：每次更新一条事件，沿用现有 snapshot 压缩节奏。

## 8. 验证

实现前在 `.qwen/e2e-tests/` 写 E2E 计划，并先对全局 `qwen` CLI dry-run 记录基线。

1. 上传 `orders.csv`，让 AI 用 `edit` 加一列 → 产物新建、出现在本 turn、可预览可下载。
2. 下一轮再改 → 同一 id 发 `updated`，状态 `available`，产物出现在最新 turn。
3. 先 `write_file` 建 `report.html`，再 `edit` 修改 → 同一 id，`toolCallId` 推进，标题不变。
4. 上传 GBK 编码、UTF-8 BOM、CRLF 换行的 CSV 各一份，让 agent 修改 → 均为 `available`，不出现 `changed`（store 对磁盘字节求 hash）。
5. 宿主先登记 `data.xlsx`（带 `clientId`），再让 agent 修改 → 同步更新，状态 `available`，标题、retention、归属不变。
6. 先 `record_artifact` 登记 `notes.md`，再在后续 turn `edit` → 产物同时出现在登记 turn 与修改 turn。
7. 上传 `orders.sql`，让 agent 用 `edit` 加字段 → 产物新建，宿主未做任何登记；`.py`、`.md`、`.json` 同理。
8. 未登记的 `src/foo.ts`（不在内置集合）被 `edit` → 不产生 artifact，store 不 stat。
9. 用户删除一个自动登记的产物，agent 再次修改该文件 → 不复活；之后 `record_artifact` 该路径 → 重建。
10. 外部修改或 agent 用 shell 修改文件 → `changed`，带提示，仍可下载。
11. 删除 artifact 快照后 `session/load`（无快照回放）→ id 与回放前一致。状态按当前文件重新求 hash，原先 `changed` 的条目会变成 `available`。
12. worktree / 多 workspace 下 write 与 edit 同一文件 → 同一 id。
13. V2 兼容契约（4.7 第 6 条）。

每个代码 PR 运行相关包的单测、`npm run build && npm run typecheck`，完成自审，并附 E2E 证据。

## 9. 开放问题

1. 外部修改（`changed`）是否需要主动发布事件，让 host 实时感知？
2. 宿主通过 `/file/write` 保存用户修改时，是否应重设基线？这需要从 workspace 作用域路由定位到 session 作用域 store，牵涉路由归属，暂不纳入。
3. 4.4 第 2 步的跨归属内容同步需要维护者确认权限边界。
