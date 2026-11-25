# Web Shell 工作区额外目录

[English](web-shell-workspace-directories.md) | [简体中文](web-shell-workspace-directories.zh-CN.md)

状态：已在工作区实现（2026-10-24），尚未合并。

## 问题

CLI 提供 `/directory add <path>` 和 `/directory show`，把额外目录加入会话的工作区上下文，并持久化到工作区设置 `context.includeDirectories`。Web Shell 没有对应入口：设置面板从不渲染这个键（它是 `showInDialog: false`，也不在 daemon 的设置白名单里），daemon 也没有读取或修改目录列表的路由。因此 Web Shell 用户无法在界面上完成 CLI 一条命令就能做的事。

## 现状

- `packages/core/src/utils/workspaceContext.ts` 持有目录集合。它用 `realpathSync` 规范化路径，拒绝不存在或不是目录的路径，把主目录标记为不可移除的 initial 目录，并提供被工作区工具使用的包含性校验（`isPathWithinWorkspace`）。`addDirectory` 遇到不可读路径只记日志并跳过，不抛错。
- `packages/cli/src/ui/commands/directoryCommand.tsx` 实现 `/directory add`：调用 `WorkspaceContext.addDirectory`，把接受的路径合并进工作区设置 `context.includeDirectories`，在 `context.loadFromIncludeDirectories` 开启时重载分层记忆，并通过 `GeminiClient.addDirectoryContext` 通知模型。
- daemon 中每个会话拥有自己的 `Config`，因而拥有自己的 `WorkspaceContext`，在会话创建时按合并设置构建；会话之间不共享 `WorkspaceContext`。工作区运行时还持有一个基础 `Config`。
- 工作区级 REST 路由通过 `resolveWorkspaceRuntimeFromParam` + `requireTrustedWorkspaceRuntime` 解析并做信任校验，写设置走 `prepareSettingWrite` + daemon 的 `persistSetting` 依赖。
- Web Shell 设置面板按 daemon 的设置描述符通用渲染（boolean / enum / number / text），并支持少量定制区块（`local-control`、`connections`、`model-management`）。它没有数组编辑器，所以即使暴露 `context.includeDirectories` 也无法编辑。
- 「添加工作区」对话框已经包含本特性需要的目录输入框、防抖补全（`workspace-path-suggestions`）和原生目录选择器（`workspace-directory-picker`）。

## 目标

- 在 Web Shell 设置面板新增 Workspace 分类，支持列出、添加、移除工作区额外目录。
- 与 CLI 语义一致：改动立即作用于工作区的运行中会话，并持久化供之后的会话继承。
- 复用已有的目录输入、补全与原生选择器。
- 主工作区目录始终可见且不可移除。

## 非目标

- 多根工作区身份。工作区仍以单一 cwd 标识，额外目录只扩大文件访问与工具搜索根。
- 编辑 user 作用域的 `context.includeDirectories`。
- 管理非当前选中的工作区，或在 daemon 无法运行的形态上管理（SSH、managed、standalone）。
- 设置面板的通用数组编辑器。

## 设计

### HTTP 接口

三条工作区限定路由，信任校验与现有 `/workspaces/:workspace/settings` 一致：

| 路由                                               | 作用                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /workspaces/:workspace/directories`           | 返回 `{ primaryDirectory, directories }`；`directories` 是持久化在工作区作用域的额外目录。 |
| `POST /workspaces/:workspace/directories`          | body `{ path }`；返回 `{ primaryDirectory, directories, changed, warnings }`。             |
| `DELETE /workspaces/:workspace/directories?path=…` | 返回 `{ primaryDirectory, directories, changed, warnings }`。                              |

`changed` 表示持久化列表是否发生变化；`warnings` 承载不阻塞变更的会话记忆或模型上下文刷新失败。

失败形态沿用现有路由：`403 untrusted_workspace`，`400 invalid_path` 一类错误码，`404 workspace_not_found`，SSH 或 managed 工作区返回 `409 directory_management_unsupported`，`409 restrictive_sandbox`，`500 persist_error`。

GET 直接读工作区设置文件，不经过 ACP 子进程。持久化列表就是新会话将继承的内容，而且不像运行时状态那样取决于哪个会话最后执行过 `/directory add`。

### 变更路径

POST 与 DELETE 转发到一个新的 ACP 控制方法 `qwen/control/workspace/directories`，参数 `{ action: 'add' | 'remove', path }`。`acpAgent.ts` 中的处理函数承担整个变更，与 CLI 命令对齐：

1. 拒绝条件：运行时处于 restrictive sandbox、会话来源是 standalone/managed-conversation-bound、或工作区 cwd 不是本地路径。
2. 添加要求绝对路径：拒绝含 NUL、不存在或非目录的路径，再用 `fs.stat` + `fs.realpath` 规范化；移除接受持久化/展示写法（绝对、相对或 `~`），按工作区根解析，仍拒绝含 NUL 的路径。
3. 移除时拒绝删除工作区主目录；添加时拒绝把主目录再加入（`primary_directory`），因为它本来就属于工作区。若某个会话已 `/cd` 到该额外目录、把它当作自己的工作目录，则跳过该会话并记录警告，而不是让整个工作区级移除失败。
4. 从环境变量已解析的设置层读取变更基线，并用解析后的值做匹配与运行中根目录的增删。把增量应用到每个运行中配置：工作区基础配置加每个活动会话的配置。添加走 `WorkspaceContext.addDirectory`，移除走 `removeDirectory`。
5. 把新列表按原始写法持久化到工作区设置 `context.includeDirectories`（去重；主目录永不写入）。
6. 对每个发生变化且开启了 `shouldLoadMemoryFromIncludeDirectories()` 的配置调用 `refreshHierarchicalMemory()`。
7. 对每个发生变化的会话调用 `getLlmClient()?.addDirectoryContext()`，让模型知道新的根目录。

记忆刷新和模型上下文通知的失败收集为 `warnings` 随响应返回；变更仍然算成功，因为目录集合与设置文件已经一致。

daemon 路由只是传输层：解析运行时、执行信任校验、把 `RequestError` 错误码映射为 HTTP 状态、返回处理结果。它不重复持久化设置，保证这个键只有一个写入方。

### 能力位

新增条件特性标签 `workspace_directories`，在 daemon 接入了 `persistSetting`（与 `workspace_settings` 相同条件）且未开启实验性双引擎时声明。双引擎会把 managed 会话放在另一个 ACP 子进程里，工作区级变更无法覆盖它，因此该模式同时省略路由与能力位，而不是只对其中一个引擎生效。需要登记到 `SERVE_CAPABILITY_REGISTRY`、开关映射表、managed 对齐表（无 managed 等价物），以及 `docs/developers/qwen-serve-protocol.md` 的条件特性表。

### Web Shell

- `WorkspaceDaemonClient` 增加 `directories()`、`addDirectory(path)`、`removeDirectory(path)`，并在 daemon 类型定义中补充对应类型。
- `useWorkspaceActions` 增加 `listWorkspaceDirectories`、`addWorkspaceDirectory`、`removeWorkspaceDirectory`，统一包一层变更超时；变更后使列表缓存失效。
- 设置面板新增 `Workspace` 分类，只在 Workspace 作用域页签渲染，内部是一个定制项，由新组件 `WorkspaceDirectoriesSection` 承载。该区块把主目录展示为只读，列出额外目录并提供移除按钮，同时提供「添加目录」。
- 添加流程复用 `AddWorkspaceDialog`，只新增两个可选 prop（`title` 与 `submitLabel`），不另写第二个对话框；路径补全与原生选择器沿用现有的工作区 actions。
- 连接缺少 `workspace_directories`、没有选中工作区、或工作区 cwd 是 SSH 地址时，不渲染该区块。
- 区块内明确提示：额外目录会扩大工作区根目录之外的文件访问边界。
- 所有新文案同时落到 `i18n.tsx` 的英文与简体中文。

## 影响文件

- `packages/core/src/**` —— 预计不改动。
- `packages/acp-bridge/src/status.ts` —— 新增控制方法常量。
- `packages/cli/src/acp-integration/acpAgent.ts` —— 控制方法处理函数。
- `packages/cli/src/serve/routes/workspace-directories.ts`（新增）及其测试。
- `packages/cli/src/serve/server.ts` —— 路由注册。
- `packages/cli/src/serve/capabilities.ts`、`packages/cli/src/serve/capability-parity.ts`、`packages/cli/src/serve/run-qwen-serve.ts` —— 能力标签与开关。
- `docs/developers/qwen-serve-protocol.md` —— 条件特性表条目。
- `packages/sdk-typescript/src/daemon/DaemonClient.ts` 及 daemon 类型。
- `packages/web-shell/client/daemon/workspace/actions.ts` 与 `types.ts`。
- `packages/web-shell/client/components/workspaces/WorkspaceDirectoriesSection.tsx`（新增）及同目录测试。
- `packages/web-shell/client/components/messages/SettingsMessage.tsx`。
- `packages/web-shell/client/components/dialogs/AddWorkspaceDialog.tsx`。
- `packages/web-shell/client/i18n.tsx`。

## 设计决策

- **由 ACP 运行时承担变更。** CLI 命令本来就在运行时里写工作区设置；只保留一个写入方可以避免两条持久化路径使用不同的锁，也能让处理函数针对真正执行工具的机器上的文件系统做校验。
- **增量而非全量同步。** 添加和移除是两个独立动作。全量同步必须规范化陈旧的持久化条目，还要决定如何处理会话在 UI 之外添加的目录。
- **对所有会话即时生效。** 用户选择了工作区级语义。只作用于当前会话会让兄弟会话在重启前看到不同的工作区视图。
- **GET 读设置。** 便宜、无需桥接往返，表达的是下个会话将继承的内容。代价是：在输入框里执行过 `/directory add` 的会话可能领先于列表，直到 UI 变更或 daemon 重启才对齐；这种不一致在所有兄弟会话上本来就存在。
- **不允许移除主目录。** 处理函数比较工作区主目录的规范化路径，主目录永远不会被删掉；被会话 `/cd` 占用的额外目录只跳过该会话并给出警告。
- **复用 `AddWorkspaceDialog`。** 它已经实现了补全、浏览、键盘交互和内联错误；再写一个选择器对话框等于重复实现。

## 安全与约束

- 增加目录会扩大工作区工具可读写的根目录。路由有信任校验，能力位显式声明，UI 也有说明。
- SSH、managed、standalone 工作区被拒绝：这些形态的文件系统校验不发生在 daemon 主机上，CLI 对 standalone 会话同样禁用了 `/directory`。
- 路由永远不接受相对路径或含 NUL 的路径。
- 持久化要求工作区已信任；未信任的写入已被现有信任校验拒绝。

## 风险

- 记忆刷新按运行中会话执行，会话很多的工作区每次变更都要付出这个成本。只有开启 `context.loadFromIncludeDirectories` 时才会发生。
- 目录可能在校验与实际使用之间消失；`WorkspaceContext` 会记日志并跳过它，下次 GET 仍会列出，直到用户移除。处理函数返回它校验过的规范化路径，客户端可以展示实际添加的内容。
- 运行时写设置与其他设置写入方共享文件；列表的读-改-写与并发 MCP 服务器编辑、或另一个客户端的目录变更并非原子。UI 会串行化自己的请求，丢失的条目可以重新添加。

## 验证计划

- 单元测试：路由状态映射与信任校验；处理函数的添加/移除/即时生效/持久化/警告；能力位声明；daemon 客户端请求形状；区块渲染、添加、移除与错误态；对话框 prop 覆盖。
- E2E：启动 daemon，列出目录，通过 UI 添加一个目录，确认运行中会话能读取其中文件；移除后确认工具边界重新拒绝该路径；重启 daemon 确认持久化。
- 条件能力表对应的文档契约测试。

## 验收标准

- 设置面板的 Workspace 页签列出主目录以及所有持久化在工作区作用域的额外目录。
- 添加合法目录后，列表包含它、运行中会话立即生效，且 daemon 重启后仍存在。
- 移除额外目录后对运行中会话生效并从设置中删除；主目录不可移除。
- 未信任、SSH、managed、standalone 工作区不展示该区块，变更请求也不会成功。
- 相对路径或含 NUL 的路径返回 `invalid_path`；不存在的路径或文件返回 `directory_not_found`。两者都不产生任何改动。

## 开放问题

没有阻塞项。如果之后需要移除确认步骤，可以在不改变 daemon 契约的前提下加上。
