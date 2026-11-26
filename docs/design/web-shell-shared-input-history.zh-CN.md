# Web Shell 跨端共享工作区输入历史

[English Version](./web-shell-shared-input-history.md)

- **状态：** 已合入 — PR #18120，squash `65616b314b`（2026-11-26），随 `v0.28.6` 发布。延后 `[P3]` 后续项跟踪于 #18423。
- **范围：** `packages/core`、`packages/cli`（Shell 历史文件锁、serve 路由、TUI `useShellHistory`）、`packages/sdk-typescript`、`packages/web-shell`、`integration-tests`
- **合入时验证：** 最终 PR head `4cfaddc70e` 上 35/35 可执行 CI 检查全绿（含 `web-shell E2E Smoke` shard 1 共 416 passed 且执行 `web-shell.shared-input-history.spec.ts`、Linux unit 两片、no-AK 集成两片、TUI parity、Serve A/B 与 Java E2E）；`verify-pr` 28/28 `merge-ready`；本地 CLI 套件 138 passed、Web Shell 套件 84 passed、真实 daemon HTTP/FS 集成 4/4、真实桌面与 Pixel 7 Chromium 双客户端 E2E 3/3（并完成 100 条上限、条件读等待及 prompt/mid-turn 落盘排序的变异击杀）。合入后 main push 车道（`Qwen Code CI`、`Managed Agent gate`、`Managed Agent loop verification`、`Web Shell Managed Host Build`、`Verify Landlock helper`、`pnpm Worktree Smoke`）全绿。覆盖边界：移动端 E2E 在 Linux Chromium Pixel 7 context 与 mock ACP model child 下运行，不替代实体手机、mobile Safari/WebKit 或 live-model 验证。

## 背景

当前 Web Shell 的输入框历史（Prompt 历史与 Shell 模式命令历史）完全保存在浏览器本地 `localStorage` 中（`qwen-web-shell-history:<workspaceCwd>` 与 `qwen-web-shell-command-history`）。当用户在手机和电脑上同时使用同一个 Web Shell 会话或工作区时，电脑上提交的历史输入在手机端的 **Input history** 面板中不可见（反之亦然）。此外，Web Shell 的 Shell 命令历史目前未按工作区隔离，也没有与 CLI 的项目级 `shell_history` 互通。

## 目标

1. 让连接到同一 `qwen serve` daemon 的多端设备（电脑、手机、多浏览器）按工作区共享 Prompt 历史与 Shell 模式命令历史。
2. 当电脑与手机同时打开同一会话时，实现近实时同步，且不引入复杂的自定义同步协议。
3. 复用现有项目级 `shell_history` 文件（`Storage(workspaceCwd).getHistoryFilePath()`），实现 Web Shell 与 TUI 共享按工作区隔离的 Shell 命令历史。
4. 完整兼容旧版 daemon、无该能力的托管后端与离线场景，平滑回退到浏览器 `localStorage`。

## 非目标

- 跨 daemon 云端同步或 Managed Host 服务端路由实现（托管端在宣告 `workspace_input_history` 前保持本地回退）。
- 跨设备输入框草稿同步。
- 改造 TUI `logs.json` 的撤销与删会话清理语义。

## 设计方案

### 1. Daemon 持久化存储（`packages/cli/src/serve/workspace-input-history.ts`）

每个工作区在 `Storage(workspaceCwd).getProjectTempDir()` 下按类型最多保存 `100` 条去重历史，该调用在 `runWithWorkspaceRuntimeStorage(runtime, ...)` 中求值。这样项目哈希对应的是所选 runtime 的 `sessionRuntimeBaseDir`：legacy-primary 路由在每次请求时重新解析当前 primary runtime，不在运行时替换后沿用旧引用；限定工作区的路由绑定明确解析且可信的 runtime。没有该上下文的裸 `new Storage(workspaceCwd)` 不得把数据写到进程默认临时根目录。

- `kind = 'prompt'`：`<project-temp>/input_history.json`，JSON `string[]`，按**从旧到新**排列（与 Web Shell `useInputHistory` 一致）。
- `kind = 'shell'`：复用 `Storage(workspaceCwd).getHistoryFilePath()`（`<project-temp>/shell_history`），磁盘上保持**从旧到新**（TUI 加载后按上键需要再反转）。共享的读取/追加辅助函数保留 JSON 与旧式行式格式，并在跨进程锁内合并 TUI 与 daemon 写入；HTTP 接口统一返回从旧到新的 `entries`。

持久化约束：

- 对输入做 `trim`，忽略空字符串及超过 `32_768` 字符的超大条目。
- 去重时将已有相同条目移至最新位置，并截断至最近 `100` 条。
- Prompt 按文件路径使用进程内异步队列串行追加，错误会传播且无游离 rejection。TUI 另以按文件的 Promise FIFO 保证快速连续提交在异步加锁前的先后顺序；一次追加异常会记录日志，不阻断后续命令，其他文件路径不受该队列阻塞。TUI 与 daemon 的 Shell 追加共享 `proper-lockfile` 跨进程锁，支持异步等待和陈旧锁回收；争用时让出事件循环，不阻塞线程。两者均在锁内重读后再写入。
- 锁失效通过 append 的 Promise rejection 告知调用方，而不是在异步回调中抛出未捕获异常。若在原子写入前已经观察到失效，则不再写入，并处理失效锁释放时的预期错误；其他释放异常仍正常传播。模块级 pending-write 集合使 hook 卸载后仍可排空写入。当前 drain 正在等待时，后续加入的写入也纳入这一轮，而不是只等待启动时的快照；集合清空后结束本轮等待；超出时限时仍遵循原有有界退出语义，不无限等待。既有每个清理函数 2 秒、整体 5 秒的上限保持不变，超过上限时不无限等待。
- 通过同目录临时文件 + `rename` 原子替换，执行 `fsync`；平台支持 POSIX 模式位时使用 `0o600`。Shell 历史的最后一次锁失效检查与原子替换在同一个同步回合里完成；锁获取、重试和读取仍是异步的，检查与最终替换之间不让出事件循环。
- 仅在文件不存在（`ENOENT`）时返回 `[]`。保留旧式行式 Shell 历史；对损坏的 Prompt 历史拒绝覆盖。TUI 与 daemon 的磁盘 Shell 历史均按从旧到新排列，TUI 仅在内存中为导航反转。
- 基于规范化结果计算轻量 `revision`（短 SHA-256 摘要），支持 `ETag` / `If-None-Match`（`304 Not Modified`）。携带 `If-None-Match` 的条件读取会在读盘前等待同路径已入队的写入结算（若写入失败则静默回退读取磁盘快照，不传播为 `500`）；无条件读取保持即时返回。

### 2. 服务端自动记录

常规提交由服务端自动写入，无需前端额外发起写请求：

- `POST /session/:id/prompt`：当受理成功（`!admission.deduplicated`）且非外部 channel 中继（`!classification.channelPrompt && !classification.requestedChannelPrompt`）时，优先取 `classification.submittedPrompt`（保留原始 `@file` / `/slash` 文本），否则拼接 `prompt` 中的文本块，写入 `runtime.workspaceCwd` 的 `prompt` 历史。
- 宿主生成的命令可显式指定 `suppressInputHistory: true` 退出记录。Web Shell 将其用于 `/model --fast`、`/language output`、`/compress` 和定时任务的手动 `Run now`；宿主命令的重试会沿首次 prompt 与重试状态继续传递该标志，而不是把所有重试都从历史中排除。普通用户输入即使没有 `submittedPrompt` 元数据，仍按上述规则回退记录。daemon 消费该标志并从转发给 agent 的请求体中移除，它不是 prompt 正文。
- `POST /session/:id/mid-turn-message`：在 `enqueueMidTurnMessage` 返回 `accepted: true` 且 `trimmed` 非空时，检查该消息原有的 mid-turn 快照，仅在所给 `messageId` 不属于已有 queued、settled、promoted ID 时写入 `runtime.workspaceCwd` 的 `prompt` 历史。被拒绝的消息和幂等 replay 确认不写入；新的有效 ID 仍正常记录。
- `POST /session/:id/shell`：校验 `command.trim()` 通过后，立即写入 `runtime.workspaceCwd` 的 `shell` 历史。

所有自动记录均为 best-effort（异常通过 `daemonLog` 记录，绝不导致会话请求失败）。Prompt 与 mid-turn-message 在返回 `202`/`200` 前等待本地原子 JSON 写入完成，确保并发跨端刷新能看到新 revision；Shell 历史写入不因跨进程文件锁阻塞命令执行。Prompt、mid-turn-message 和 Shell 自动记录均使用目标会话所属 runtime 同一套存储上下文。

### 3. HTTP 路由与能力宣告

路由作用域与信任边界：

| 路由                                        | 作用域归属         | 信任与失败语义                                                                                                                  |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workspace/input-history`              | `legacy-primary`   | 检查 primary generation 未关闭；返回 `200 { kind, entries, revision }` 或命中 `If-None-Match` 时返回 `304`。                    |
| `POST /workspace/input-history`             | `legacy-primary`   | 挂载 `mutate()`；检查 primary generation 未关闭；供纯客户端本地命令（如不走 `/prompt` 的本地斜杠命令）追加 `{ kind, entry }`。  |
| `GET /workspaces/:workspace/input-history`  | `selected-runtime` | 走 `resolveWorkspaceRuntimeFromParam` + `requireTrustedWorkspaceRuntime` + generation 守卫；绝不回落 primary。                  |
| `POST /workspaces/:workspace/input-history` | `selected-runtime` | 挂载 `mutate()`；走 `resolveWorkspaceRuntimeFromParam` + `requireTrustedWorkspaceRuntime` + generation 守卫；绝不回落 primary。 |

参数与请求体校验：

- `kind`：`POST` 必填，`GET` 可选（默认 `'prompt'`），仅允许 `'prompt' | 'shell'`（否则 `400 invalid_input_history_kind`）。
- `limit`（`GET` 可选）：`1..100` 的正整数（否则 `400 invalid_limit`）。
- `entry`（`POST` 必填）：trim 后非空且长度不超过 `32_768` 字符的字符串（否则 `400 invalid_entry`）。

跨域条件同步要求 daemon 的 `Access-Control-Allow-Headers` 包含 `If-None-Match`。现有授权和 Origin 限制不变。

能力宣告：

- 在 `packages/sdk-typescript/src/daemon/capabilities.ts` 注册 `workspace_input_history: { since: 'v1' }`（由 `packages/cli/src/serve/capabilities.ts` re-export，`qwen serve` 无条件宣告）。
- 在 `packages/cli/src/serve/capability-parity.ts` 登记为 `NO_MANAGED_EQUIVALENT('no Managed input history route')`。

### 4. Web Shell 同步与降级

- **Workspace Actions（`packages/web-shell/client/daemon/workspace/actions.ts`）**：
  - `loadInputHistory({ kind, limit, workspaceId, ifNoneMatch })`：非 primary 可信工作区请求 `/workspaces/:id/input-history`，primary 请求 `/workspace/input-history`；命中 `304` 返回 `{ notModified: true }`，否则返回 `{ notModified: false, entries, revision }`。
  - `recordInputHistory({ kind, entry, workspaceId })`：best-effort `POST`，用于不经过 `/session/:id/prompt` 的本地斜杠命令。
- **目标工作区解析**：
  - 仅在 `capabilities.features` 包含 `'workspace_input_history'` 时启用。
  - 若指定了非 primary 的 `atWorkspaceCwd`，要求同时具备 `'workspace_qualified_rest_core'`、在 `capabilities.workspaces` 中唯一命中且 `trusted !== false`；未知、歧义或未信任工作区严格保持纯本地模式，绝不回落 primary `/workspace/input-history`。
- **除目标信任外的 scope 绑定**：
  - 隐式 legacy-primary 继续支持，因为 primary 路由有唯一绑定目标。对于显式选择的工作区，Prompt/Shell 浏览器存储 key 必须与该目标工作区 scope 的编码一致，才能进行远端读取和 pending 跟踪。显式共享且非规范 scope 的 key 保持纯本地：不读取其他工作区快照、不推进其 pending 过期，也不创建确认标记，且不得悄悄回落到无关 primary 目标。
  - 非 primary 的 target key 带 `workspace:` 前缀，因此服务端分配的 `<primary>` 字面 id 不会与 legacy-primary 保留标记冲突。实际 workspace ID 及其编码 URL 路由保持不变。
- **Shell 历史按工作区隔离**：
  - Shell 历史 `localStorage` key 改为按工作区隔离（`qwen-web-shell-command-history:<workspace>`），并在允许回退时兼容旧 key `qwen-web-shell-command-history`。
- **`useComposerCore.ts` 中的同步触发时机**：
  1. 挂载与切换工作区时预拉（预拉 prompt 历史；处于 shell 模式时预拉 shell 历史）。
  2. 打开 Input history 面板时（`openHistorySearch`，桌面 `Ctrl+R` 或手机 `+ -> Input history`），异步返回后若面板仍处于打开状态，立即刷新 `searchMatches`。
  3. 从空闲态首次按 `↑`（`!isNavigating()`）时触发一次条件刷新。
  4. 窗口 `focus` / `visibilitychange`（`visible`）时刷新，覆盖手机切回浏览器标签页的场景。
  5. 实时跨端 SSE 信号（`remotePromptSidechannel.ts`，由 `DaemonSessionProvider.tsx` 在收到来自其他 `originatorClientId` 的实时 `user.text.delta` 或 `midTurnInjected` 时发布），在电脑和手机同时打开同一会话时立即触发条件刷新。
- **合并与竞态防护（`useInputHistory.ts`）**：
  - `mergeRemoteInputHistory(localEntries, remoteEntries, previousRemoteEntries?)`：把真正的本地独立条目排在旧远端条目前，但只要存在远端历史，就至少保留一个刚到达的远端条目。旧版本已有 `100` 条纯本地历史时，因此保留最近 `99` 条，而不是完全隐藏远端输入。合并结果始终不超过 `100` 条。
  - 在 `${storageKey}:remote-source` 中旁存合并结果里实际来自远端的条目集合。曾由 daemon 提供、但已从滚动窗口淘汰的旧项不得因此晋升为纯本地条目。该集合同样遵守 `100` 条上限；写入采用 best-effort，浏览器持久化不可用时，下一次被接受的远端快照仍会在内存中校正分类。该来源 key 缺失时，旧窗口的来源是不确定的。即使旧记录刚被确认，也不能仅凭有序的文本重叠，把整窗当作远端权威历史；这些不明确的条目会在上限内继续按本地历史保留，避免无证据地删除用户输入。来源明确时，远端窗口前进会淘汰相应的旧远端项，包括确认此前存在的待确认输入之后。显式存在的空来源数组是已知的空集合，不是来源缺失。
  - 维护每次本地 `push()` 递增的变更序号，防止请求发起后、响应返回前发生的新本地提交被陈旧的 `GET` 响应覆盖。每次 target 变化分配 generation，每次请求使用独立身份。A→B→A 切换不得使旧 A 响应重新获得权威性，也不得让旧完成回调清除新请求的 in-flight 状态；只有匹配的完成回调才恢复排队刷新。
  - 对每个存储作用域，采用与浏览器历史相同的 `100` 条上限跟踪已经 trim 且长度合法、尚未被 daemon 确认的本地条目，在浏览器历史中旁存 `{ text, seenRemoteRevision?, missedRemoteSnapshots, hadLocalBefore? }`。兼容迁移旧 `string[]` 标记和规范化重复项，保留最新的有效标记；在首次挂载和作用域切换时恢复顺序；不支持远端历史时不创建新标记；空白或超长输入不得形成永久 pending。
  - 远端 revision 未变化时，将未确认输入保持在最新尾。已知基准之后，两个具有不同新 revision 且均未包含该条目的响应才使其过期。合并前移除过期或确认过的 pending 排序标记，已确认项以 daemon 权威顺序为准，且不得挤出剩余远端窗口。`hadLocalBefore` 只表示先前不是已标识远端来源的本地副本。过期时仅保留这类旧副本、清除 pending 标记；已经是远端来源的条目不设置该标记，避免重复提交后再过期时把淘汰的远端项冒充为独立本地历史。只有没有旧本地副本的全新提交才可被丢弃。来源不明仍按上述保守规则保留。变更序号过期的响应既不能推进过期，也不能覆盖刚提交的本地输入。
  - 异步合并不打乱正在浏览的历史与草稿；搜索面板关闭时不触发宿主组件额外重渲染，保持既有无重渲染不变量。
  - 仅在精确解析出远端历史 target 时创建 pending 标记；未知、歧义或不受信任的工作区保持纯本地模式。
  - 本地 Slash 命令在异步分配等待后被受理时，同时比较存储身份、精确的远端历史 target key 和 workspace cwd。若同一 live key 在工作区切换中被复用，不得把命令记录给新选中的工作区；可使用提交开始时锁定的 target，或明确跳过这次远端写入。无论可选工作区列表缺失还是随后补齐，primary 的 key 均表示同一稳定路由目标，能力元数据细化不得误判同 primary 的受理。分配 session 时的 session/draft 身份变化不绕过该检查：同 target 的延迟 Slash 命令仅记录一次，工作区不匹配仍禁止远端写入。
  - pending 确认采用 daemon 相同的 trim 口径，不保留原始空白变体形成的重复项。legacy pending 迁移在上述历史窗口上限内按原顺序保留有效标记。

## 验收标准

1. 在电脑端提交普通 Prompt 或 mid-turn 消息后，同一工作区的手机端无需手动刷新页面即可在 Input history 面板看到该条目。
2. 在电脑端执行 Shell 模式命令后，手机端 Shell Input history 可看到该命令，且持久化于 `<project-temp>/shell_history`。
3. 多工作区路由（`/workspaces/:workspace/input-history`）严格限定在解析出的可信 runtime 内，对未知、未信任或已关闭 generation 的工作区返回明确错误，绝不回落 primary。
4. 不具备 `workspace_input_history` 能力的旧版 daemon、离线浏览器与独立单测继续通过 `localStorage` 正常工作，无报错或多余重渲染。
5. 明确指定替代 runtime 存储根目录后，HTTP 写入和自动 Prompt/Shell 记录均写入该根目录；任何路由或记录路径都不得落回进程默认临时目录。
6. 指定 `suppressInputHistory: true` 的宿主生成命令不进入 Prompt 历史，也不出现在转发给 agent 的请求体中；普通用户 Prompt 和可选元数据回退仍可正常记录。
7. 尚未确认的 pending 输入不得永久占据最新端或反复挤出真正的跨端条目。过期后满 `100` 条的远端窗口保持完整，独立来源的本地条目则保留可容纳的本地窗口。
8. 本地 Slash 命令的受理若跨越工作区切换，不得被追加到新选中的工作区远端历史。仅 session/draft 身份变化且工作区未变时，仍应向同一 target 记录一次。
9. 已明确标为远端来源的旧条目被 daemon 淘汰后，不得在连续全量快照后残留为本地条目；来源不确定的旧记录则保守保留可容纳的本地窗口；旧本地历史占满窗口时，仍需保留新到远端条目的可见位置。
10. 显式共享且非规范的存储 key 不得让其他工作区快照重排、确认或过期其本地条目。字面值 `<primary>` 的非主工作区 id 不得与主工作区标记冲突，隐式 legacy-primary 同步仍须可用。
11. 宿主命令重试仍保持 opt-out；锁失效不得产生未捕获异步异常，hook 卸载后，仍在写入的命令必须受有界退出清理排空。
