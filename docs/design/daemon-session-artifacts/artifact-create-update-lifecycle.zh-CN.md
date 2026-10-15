# Session Artifact 创建与更新生命周期

[English](artifact-create-update-lifecycle.md) | [简体中文](artifact-create-update-lifecycle.zh-CN.md)

- 状态：提案（未实现）
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
  → ACP tool_call_update._meta.artifacts          (cli: tool-call-emitter.ts)
  → bridge extractSessionUpdateArtifacts          (acp-bridge: bridgeClient.ts；按字段白名单透传，转发给客户端前剥离 _meta.artifacts)
  → SessionArtifactStore.upsertMany               (acp-bridge: sessionArtifacts.ts；串行 mutation 队列)
      expandWorkspaceDirectoryInput → normalizeInput（stat + hash，建立 qwen.workspace.* 基线）
      → 不存在则 created；存在则 mergeArtifact → 公开字段有变化则 updated
  → artifact_changed SSE → web-shell 全量刷新列表
```

其他入口：PostToolUse hook 的 `hookSpecificOutput.artifacts`、客户端 `POST /session/:id/artifacts`、slash 命令的 `_meta.sessionArtifacts`。

### 2.2 哪些工具会产出 artifact

| 工具                                 | 是否产出 | 说明                                                                                                                                                     |
| ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_file`                         | 部分     | 仅 `ARTIFACT_KIND_BY_EXTENSION` 中的扩展名（`.csv/.htm/.html/.ipynb/.jpeg/.jpg/.pdf/.png/.svg/.webp` 和 office 文档）；`record_as_artifact=false` 可关闭 |
| `record_artifact`                    | 是       | 模型显式调用                                                                                                                                             |
| `artifact` / `image_gen` / omni 工具 | 是       | 发布型 HTML、生成图片、媒体派生物                                                                                                                        |
| `edit`（包括用 edit 新建文件）       | 否       | 所有返回路径都只有 `llmContent` + `returnDisplay`                                                                                                        |
| `notebook_edit`                      | 否       | 无任何 artifact 引用                                                                                                                                     |
| `run_shell_command` / MCP 工具       | 否       | 本设计不处理（见第 6 节）                                                                                                                                |

### 2.3 Store 合并语义

- 身份：`stableSessionArtifactId(sessionId, 'workspace:<canonicalPath>')`，同一路径即同一个 artifact。
- 基线：`normalizeInput` 在队列内 stat 并 hash 文件，写入 `qwen.workspace.sha256 / mtimeMs / sizeBytes`；list/get 按 5 秒 TTL 懒刷新，实时内容偏离基线即置 `changed`，**不发布事件**。
- 基线只来自 store 自己的读取：`normalizeMetadata` 会剔除输入里的 `qwen.workspace.*` 键；实时 `upsertMany` 调用 `normalizeInput` 时不传 `workspaceExpected`，只有 restore 路径用已持久化的指纹作为期望值。因此今天无法让工具声明"我写入的是哪份内容"，写入与登记之间的外部改动会被直接吸收为基线。
- `mergeArtifact` 中 `status`、`sizeBytes` 总是取本次输入；`metadata` 走 `mergeMetadata`，后者在 `incoming.source !== existing.source`（或来源为 hook）时直接保留旧 metadata，**不采纳新指纹**。
- 展示字段（`title`、`description`、`toolCallId`、`toolName`、`source`、`hookEventName`）只在 `shouldRefreshWorkspaceDisplay` 为真时刷新：`record_artifact`（非 hook）、无 `toolName` 的登记，或 `toolName` / `source` / `hookEventName` **三者都相同**。注释明确要求自动登记不得覆盖用户可见标题。
- "文件消失即遗忘"（`isVanishedAutoRecordedWorkspaceArtifact`）和存在性复查（`shouldRecheckWriteFilePresence`）都写死 `toolName === 'write_file'`。

### 2.4 Web Shell

- `canDownloadArtifact` 已同时接受 `available` 和 `changed`，`ArtifactPanel` 对两者的预览一致，并有测试覆盖。缺的只是 `changed` 的"已在会话外修改"提示。
- turn 归属：`record_artifact` 参数里的路径可以出现在多个 turn；其余按 `artifact.toolCallId` 只出现在一个 turn。

### 2.5 问题清单

| #   | 问题                                                                    | 后果                                                                                      |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| G1  | 只有 `write_file` 自动登记，`edit` / `notebook_edit` 不登记             | 上传后被修改的文件、用 edit 新建的文件找不到                                              |
| G2  | 已登记产物被 `edit` 修改时，没有任何 upsert                             | 不重设基线、不发事件；之后被标成 `changed`                                                |
| G3  | `mergeMetadata` 跨 source 不采纳指纹                                    | client / `record_artifact` 来源以外的组合下，即使有 upsert 也会回到 `changed`             |
| G4  | `shouldRefreshWorkspaceDisplay` 要求 `toolName` 相同才推进 `toolCallId` | `write_file` 创建、`edit` 修改时，产物停在创建的 turn；修改的 turn 看不到（由评论者指出） |
| G5  | 遗忘/复查规则写死 `write_file`                                          | 由 `edit` / `notebook_edit` 创建的产物无法被正确遗忘或复查                                |

说明：`write_file` 与 `edit` 的 source 都是 `tool`，所以在 G1 修好后，两者之间的指纹采纳和 `updated` 事件本身是正常的；G4 只影响 turn 归属，G3 影响跨 source 的组合（例如客户端登记后由 agent 修改）。

## 3. 目标与非目标

目标：

1. Agent 用 `write_file` / `edit` / `notebook_edit` 在工作区内**创建或修改**的交付物，按同一策略进入 artifact 列表。
2. Agent 修改**已登记**的文件（任意扩展名、任意登记来源）时，同一 id 发 `updated`，重设基线，状态保持 `available`。
3. 产物至少出现在最近一次修改它的 turn。
4. 已有会话里的 artifact 安全共存：身份规则不变，不迁移、不扫盘、不批量重置。

非目标：

- 不新增扩展名配置项；内置集合只追加 4.2 列出的四个扩展名。
- 不做 revision 轨迹、内容快照、shell 产物检测（拆为独立 issue，见第 6 节）。
- 不把普通源码编辑一律变成 artifact。
- 不覆盖远程 execution worker 内的文件。

## 4. 方案

### 4.1 生命周期规则

| 事件                                                   | Store 行为                                   | status    | 事件         |
| ------------------------------------------------------ | -------------------------------------------- | --------- | ------------ |
| Agent 写入匹配策略且未登记的文件                       | 新建，建立基线                               | available | created      |
| Agent 写入**已登记**的文件（任意扩展名、任意登记来源） | 更新，重设基线，`toolCallId` 推进到本次调用  | available | updated      |
| Agent 写入未登记且不匹配策略的文件                     | 忽略（不 stat、不 hash）                     | –         | –            |
| 内容未变的重复写入 / 真正的 no-op edit / 写入失败      | 不产生候选                                   | –         | –            |
| 用户或外部进程修改                                     | 懒刷新时发现                                 | changed   | 无（不变）   |
| 文件被删除                                             | 自动登记的产物被遗忘；显式登记的标为 missing | missing   | removed / 无 |
| `write_file` 设置 `record_as_artifact=false`           | 只阻止新建；已登记的产物仍同步               | –         | –            |

语义：`changed` 只表示"非 agent 写入导致的偏离"；agent 自己的成功写入一律重设基线。

### 4.2 共享自动登记策略

把 `write-file.ts` 中的扩展名映射、工作区路径解析、跳过目录、展示安全检查、MIME/kind 推断抽到 `packages/core/src/tools/artifact/workspace-auto-record.ts`。`write_file`、`edit`（含新建）、`notebook_edit` 在**写入成功提交之后**调用：

- 返回 `null`：artifact 功能关闭、不在工作区、位于跳过目录、路径或标题不安全。
- 匹配内置扩展名：返回普通候选。
- 不匹配，或 `record_as_artifact=false`：返回 `updateOnly: true` 的候选。
- 候选通过新增的入站字段 `expectedSha256` 携带本次写入内容的 hash（工具内存中已有内容，计算无额外 IO）。

内置扩展名集合在现有基础上追加 `.sql`、`.py`、`.md`、`.json`，kind 均为 `file`。它们是数据与分析场景最常见的交付物；不做成配置项，是为了不引入新的 settings 面。现有的跳过规则（点目录、`node_modules`、`dist` 等）与 `record_as_artifact=false` 继续生效。artifact 登记出错不得让一次成功的文件写入变成失败的工具调用。只有新建产物时在 `llmContent` 追加提示，`updateOnly` 候选不追加。

### 4.3 入站指令：`updateOnly` 与 `expectedSha256`

```ts
interface ToolArtifact {
  // ...existing
  /** 只更新已存在的同身份 artifact；不存在时丢弃。不持久化。 */
  updateOnly?: boolean;
  /** 工具刚写入内容的 sha256，store 用作期望指纹。不持久化。 */
  expectedSha256?: string;
}
```

- 两个字段都要在 `bridgeClient.ts` 的 `artifactPayloadFields` 白名单中显式加入，并加到 `SessionArtifactInput`，否则会被过滤掉；ACP `_meta.artifacts` 只新增可选字段，旧客户端忽略。
- 它们是入站指令，不是 artifact 状态，不写入 journal/snapshot，也不出现在公开 artifact 上。
- `expectedSha256` 不经过 metadata，因此不放宽"输入方不得自行写入 `qwen.workspace.*`"的现有规则；它只能让结果更保守（不一致时得到 `changed`），不能凭空设定基线。
- `updateOnly` 只收紧不放宽：hook 与 client 来源也可以使用。

### 4.4 Store 改动（`sessionArtifacts.ts`）

1. **`updateOnly` 先短路**：在串行队列内、`expandWorkspaceDirectoryInput` 之前，按规范化路径算出身份并检查是否存在；不存在则直接丢弃——不建、不删、不驱逐、不发布、不 stat/hash。存在时走正常的 `normalizeInput` 验证。
2. **期望指纹校验（新增接线）**：`upsertMany` 把入站的 `expectedSha256` 转成 `normalizeInput` 的 `workspaceExpected: { sha256 }`。底层 `getWorkspaceStatus` 已有的比对逻辑直接复用：hash 一致时返回 `available` 并由 `withWorkspaceContentHashMetadata` 写入新基线；不一致（写入后又被外部改动）时返回 `changed`，且该函数只在 `available` 时写基线，因此陈旧读取不会成为基线。未携带 `expectedSha256` 的输入（client、hook、`record_artifact`）行为与今天一致。
3. **跨 source 采纳指纹**：`mergeMetadata` 对 `isAdoptableContentFingerprintKey` 的键（`qwen.workspace.*`），在来源为 `tool` 且已通过第 2 步校验时，不再要求 source 相同；其他 metadata 键、hook 来源、发布者信任规则不变。
4. **按文件身份推进 turn 归属**：把"推进 `toolCallId`"与"刷新标题/描述"拆开。当入站候选来自自动登记生产者集合 `{write_file, edit, notebook_edit}`、且内容指纹确实变化时，`toolCallId` 推进到本次调用；`title`、`description`、`toolName`、`source`、`hookEventName`、所有权与 retention 仍按现有 `shouldRefreshWorkspaceDisplay` 规则，自动登记不得覆盖用户可见标题。`toolName` 保留创建者，使遗忘规则仍按"谁创建"判定。
5. **泛化遗忘/复查谓词**：`toolName === 'write_file'` 改为 `source === 'tool' && toolName ∈ {write_file, edit, notebook_edit}`；client 登记、`clientRetained`、`record_artifact` 显式登记的条目行为不变。

不采用的替代做法：让 `edit` / `notebook_edit` 伪装成 `toolName: 'write_file'`（耦合到一个不真实的名称）；整体放宽 `shouldRefreshWorkspaceDisplay`（会让自动登记覆盖用户标题）。

### 4.5 Web Shell（第一个实现 PR 内）

- 不改下载规则（`changed` 已可下载）。
- `changed` 卡片增加"已在会话外修改"提示，并加回归测试固定 `changed` 可下载的现有行为。
- turn 归属随 `toolCallId` 推进自动跟到最近一次修改的 turn，与今天 `write_file` 重写的行为一致；不改 `artifactsByTurn` 类型。

### 4.6 上传文件

- 上传到工作区后被 agent 修改的文件：匹配内置扩展名（含新增的 `.sql`、`.py`、`.md`、`.json`）时，第一次修改即由 4.2 新建，宿主无需在上传时额外登记。
- 内置集合之外的类型：agent 修改它们不会新建 artifact；只有在已经以其他方式登记过时，才会经 `updateOnly` 同步。
- 只上传、未被修改的文件是输入，qwen-code 不主动登记。

### 4.7 对已有 artifact 的兼容性

**不需要数据迁移，不会扫盘补登记，不改已有 artifact 的 id。** 持久化仍为 V2 journal/snapshot，本设计不新增持久化字段。

| 场景                                              | 升级后行为                                                            | 处理                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| 已有 artifact，升级后无人再改                     | 与今天一致                                                            | 无                                                    |
| 工作区里从未登记过的文件                          | 不会被补登记                                                          | 只有 agent 再次写入（且匹配策略）或显式登记才可能新建 |
| 已有会话中的 `.sql/.py/.md/.json` 文件            | 不补登记；升级后 agent 再次修改时才新建                               | 这是默认值放宽带来的预期行为变化                      |
| 已有 artifact 被 agent 再次修改                   | 同一 id 发 `updated`，重设基线，`toolCallId` 推进                     | 这是修复                                              |
| 已经是 `changed` 的旧条目（多为过去 edit 未同步） | 保持 `changed`（可下载），直到下次 agent 写入                         | **不批量重置**：无法区分旧缺陷与真实外部修改          |
| client / hook / `record_artifact` 登记的产物      | 身份、所有权、标题、retention、tombstone 不变；agent 修改时采纳新指纹 | 无                                                    |
| published / managed / link / external_url         | 不走 workspace 自动登记路径                                           | 无                                                    |
| 旧 bridge + 新 core                               | 旧白名单会过滤掉两个新字段，`updateOnly` 候选被当作普通登记而新建     | core 与 acp-bridge 改动必须在同一次发布中落地         |
| 旧 web-shell + 新 daemon                          | 只是没有 `changed` 提示                                               | 无                                                    |

实现与评审必须保持的约束：

1. 身份键不变：`workspace:<canonicalPath>`（及 managed/url）。
2. 不扫盘、不 backfill。
3. 不批量把 `changed` 改成 `available`。
4. `updateOnly` 永不删除或驱逐已有条目。
5. 契约测试：用升级前写下的 V2 snapshot/journal fixture restore，断言条数与 id 不变；对其中一条 `edit`，断言同一 id、动作为 `updated`；另一条未触碰但已被外部修改的条目仍为 `changed`。

## 5. 分期

### 5.1 PR 1：一致的创建/更新（本设计主体）

- core：共享策略模块；`write_file` 改为调用它；`edit`、`notebook_edit` 返回 artifacts；`ToolArtifact.updateOnly` / `expectedSha256`；工具描述同步。
- acp-bridge：白名单透传两个新字段；`updateOnly` 短路；`expectedSha256` 接入 `workspaceExpected`；跨 source 指纹采纳；`toolCallId` 按文件身份推进；遗忘/复查谓词泛化。
- web-shell：`changed` 提示与回归测试。
- 测试：三个工具的单测；store 覆盖 `updateOnly`（未知丢弃且不 stat、已知更新）、跨 source 重设基线、`write_file` 建 + `edit` 改后 `toolCallId` 推进且标题不变、由 `edit` 创建的产物被遗忘、并发排队更新、陈旧读取不成为基线；V2 兼容契约测试。

默认扩展名追加四项，不加配置，PR 本身即可独立交付价值。

### 5.2 后续 PR：按 turn 展示多次修改

在现有基于 transcript 的引用分组上，纳入已完成的 `write_file` / `edit` / `notebook_edit` 输出路径，与权威 artifact 列表按规范路径匹配；同一产物在每个修改它的 turn 显示，turn 内去重，后续出现带"已更新"标记。由 transcript 派生，刷新与回放后不坍缩到最新 `toolCallId`，**不改 store 数据模型**。卡片展示当前内容，不代表历史快照。

## 6. 拆分出去的范围（单独开 issue）

- 每个 artifact 的有界 revision 轨迹（工具调用、hash、大小）及 revision 内容快照。
- 前台 shell 命令创建/修改文件的检测与归因。
- MCP 工具结果 `_meta` 的 artifacts 映射。

## 7. 风险

- **把每次写入都当成新产物**：由"内置策略之外一律 `updateOnly`"约束，并有测试覆盖。
- **编码场景噪音**：新增的 `.md`、`.json`、`.py` 在普通编码会话里很常见（README、`package.json`、源码），被 agent 修改后都会成为 artifact。缓解：跳过目录规则不变；`record_as_artifact=false` 仍可逐次关闭；store 200 条上限与驱逐规则不变。这是选择放宽默认值而非新增配置的代价，评审时需确认可接受。
- **把未验证的指纹当作基线**：由队列内 stat/hash 与 `expectedSha256` 比对约束。
- **大文件**：超过 100MB 不 hash，携带 `expectedSha256` 时按现有逻辑返回 `changed`；工具对这类文件不应携带该字段，保持今天按大小建立基线的行为。
- **性能**：未登记文件的 `updateOnly` 候选在 stat 之前短路；已登记文件每次修改 stat + hash（沿用现有 100MB 上限）。
- **journal 增长**：每次更新一条事件，沿用现有 snapshot 压缩节奏。
- **turn 归属变化**：已有产物被再次修改后会出现在新的 turn，这与 `write_file` 今天的行为一致，属预期。

## 8. 验证

实现前在 `.qwen/e2e-tests/` 写 E2E 计划，并先对全局 `qwen` CLI dry-run 记录基线。

1. 上传 `orders.csv`，让 AI 用 `edit` 加一列 → 产物新建、出现在本 turn、可预览可下载。
2. 下一轮再改 → 同一 id 发 `updated`，状态 `available`，产物出现在最新 turn。
3. 先 `write_file` 建 `report.html`，再 `edit` 修改 → 同一 id，`toolCallId` 推进，标题不变。
4. 宿主先登记 `data.xlsx`（client），再让 agent 修改 → 同步更新，不变成 `changed`，所有权与 retention 不变。
5. 上传 `orders.sql`，让 agent 用 `edit` 加字段 → 产物新建，宿主未做任何登记；`.py`、`.md`、`.json` 同理。
6. 未登记的 `src/foo.ts`（不在内置集合）被 `edit` → 不产生 artifact，store 不 stat。
7. 外部修改文件 → `changed`，带提示，仍可下载。
8. 写入后、登记前文件又被外部改动（单测模拟）→ `expectedSha256` 不一致，状态 `changed`，基线不更新。
9. worktree / 多 workspace 下 write 与 edit 同一文件 → 同一 id。
10. V2 兼容契约（4.7 第 5 条）。

每个代码 PR 运行相关包的单测、`npm run build && npm run typecheck`，完成自审，并附 E2E 证据。

## 9. 开放问题

1. 外部修改（`changed`）是否需要主动发布事件，让 host 实时感知？
2. 宿主通过 `/file/write` 保存用户修改时，是否应重设基线？这需要从 workspace 作用域路由定位到 session 作用域 store，牵涉路由归属，暂不纳入。
