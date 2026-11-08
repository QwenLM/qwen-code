# Managed 扩展包

[English](2026-10-24-managed-extension-packages.md) | [简体中文](2026-10-24-managed-extension-packages.zh-CN.md)

## 状态与基线

基于 `101b3d416de4b7a7dca094afd475549013d8b7d5` 实现。
代码正在验证中。本文记录已采纳设计，不代表运行验收完成。

## 问题与范围

Managed Session 已能加载发布的静态 Skills、MCP pins 和 Hook catalog，
但不能安装、分发和显式应用完整扩展包。普通已安装目录不可直接移植：
加载器展开本机路径与环境变量，转换器会改写 plugin root，Release 选择依据安装机平台。
直接复制会带入错误字节或凭据。

首期支持静态 Skills 与资产、commands、声明式 agents、context、MCP、Hooks 和版本化 settings。
在有损转换前拒绝动态 Skill 权限、Hooks、模型覆盖、路径激活，agent 私有 MCP/Hook，
executor、LSP、channels 和 workflows。不构建依赖。
执行目标为本地 Linux、SSH Linux，以及显式开启的原生 macOS 开发者进程组监管。
这不表示兼容普通 CLI 的所有语义。

## 包与设置归属

对原始 Git/npm/目录/archive 输入复用现有获取、转换和解析原语，显式传入目标平台和根。
准备时不初始化 Config，不修改共享进程环境或 cwd。
保留占位符，直到目标 Runtime 编译。导入已安装扩展须重新获取原始来源。

规范 archive 为根目录包含 manifest 的 tar.gz；包摘要为 archive 字节的 SHA-256，
元数据记录来源修订、目标平台和编译器版本。所有来源统一执行既有压缩 100 MiB、
展开 1 GiB、100,000 个条目的上限。拒绝逃逸资源和不支持的 archive 链接。
外部解释器是目标依赖，不冒充包内资源。

控制面在配置的耐久 artifact 目录保存不可变 archive，SQL 按租户与 Workspace
保存元数据、操作和引用。使用有界二进制流，不把 base64 大包放进 JSON 或 Session 资源。
生产多副本要求共享持久存储。Runtime 私有 state 目录仅作校验缓存，不是唯一恢复来源。
安装版本、Session/child pin、未决恢复和历史引用未释放前，不回收字节。

Settings 使用不可变加密修订，复用 SecretProtector 与密钥轮换；加密上下文绑定租户、
Workspace、extension 和 settings revision。不复制源 Keychain selector、.env 或凭据 sidecar。
只向选定 Runtime 及所属扩展子进程交付精确设置。公开响应、日志和浏览器持久化仅含引用、
已配置键，不含值。

发布和 Runtime 执行分别默认关闭。控制面要求配置耐久 artifact 目录及允许的 actor，
Workspace OPERATOR 授权仍为必要条件。Runtime 执行还需选择平台监管 profile 与私有缓存目录。
此增量保留已发布版本和 settings，不执行 GC。
参见[部署配置](../../packages/managed-agent-server/distribution/config/application.example.yml)。

## 会话配置与恢复

保持 AgentDefinition 身份与基础工具 profile 不变。effective configuration 组合基础定义、
独立 MCP 选择、不可删除的基础 Hooks，以及所选包贡献项。
创建、加载、resume、恢复读取同一 binding；包 pin 不冒充 definition pin，也不提升 profile。

创建 Session 接受可选的 `extensionPins`：省略或 null 保持旧流程，显式空数组选择空的新格式包配置。
创建幂等摘要包含精确 pins，并在创建 Session 前核验包所属 Workspace 及部署权限。
初始 pins（包括显式空选择）要求受支持且已协商 lifecycle v2 的 Shell/1 或 MCP/1 profile，在持久化 Session 或创建 receipt 前拒绝不兼容 profile。
现有创建 receipt 的 v2 在可选静态 Skills 快照旁保存不可变的 `initialSelection`，v1 保留原语义，
不新增安装账本或 schema 列。私有 create/load 传递同一 expectedRevision 为 0 的命令，
首次模型提交前通过正常 config_install 完成 bootstrap；其他命令或首次 Turn 已提交后的 bootstrap 均拒绝。
初始化未完成时阻止推理，恢复仍只针对原操作及原执行者。
在首次提交前，精确初始命令也可通过正常 successor 校验，以第 2 版恢复之前内容。
子 Session 只接受原 bootstrap 操作的继续或显式恢复，operator 不能替换其包选择。
冷启动管理加载保持被动，让失败初始化可修复，同时继续阻止推理。

SSH 子执行要求新创建时持久化的 public-child 合同及已开启的 extension 执行 profile，
修改部署不会提升旧 Session。父子保留各自 Runtime owner 和凭据；包 agent 启动在锁内核验
父配置的原 READY binding、generation 和 active slot。远程 worktree 与 snapshot 子任务仍不可用。

在既有 config_install domain 增加闭合 tagged 正文，保留 managed-config_install/1 和旧 MCP 记录。
不使用包的会话保持旧路径。首次 apply 导入独立 MCP/基础 Hooks；进入新格式后，
即使移除全部包，MCP 写入也继续统一适配。日志 phase、实际配置和 MCP component revision 分开。

应用采用有停顿的排空重配：prepare，stage 不可变输入并核验双方 ACK；同事务提交
config_install/config.bound 与准入屏障；排空变更的 Session 组件；启用替代项；
核验双方 enable ACK；发布 active。Stage 不连接 MCP、不执行 Hook。
Stage 失败时旧配置继续可用；commit 后只对账原 operation/owner。
结果未知时保持屏障，不在另一 Runtime 重放。

显式恢复上一版先证明替代 owner 已停止，再将旧内容编译为新的 effective catalog/configuration
修订。不降低 Hook/MCP 版本、不擦历史、不重置基础 once、不补跑 SessionStart。
Runtime 对账接受精确的原 prepared、pending 或 active 操作，包括重启后的状态；不能停止较新的配置。
更新一个 Session 不能关闭、封闭或退役整个 Runtime。

## 组件与平台接线

Skills 保留真实来源及原生命名、冲突规则；旧静态 Skill 来源不明时明确冲突，不猜测替换。
固定包资产使用只读 source 命名空间，不放宽 Workspace 路径、不进入 file history。
Shell 的扩展执行上下文提供目标包根，cwd 仍是 Session 目录。
缓存漂移时拒绝使用并可重建。产品只读访问不意味着新增同 UID Shell 沙箱。

模型工具 schema 列出已选的公开 package pins。Read/Glob 在匹配的显式 source 下接受
包内相对路径或 `extension://<extensionId>/<path>`，指令根使用该逻辑命名空间。
Shell 通过显式扩展上下文取得 `QWEN_EXTENSION_ROOT`。指令正文不添加私有缓存路径或设置值。
升级所选包保留精确 settings revision；用户可以显式复用最新保存修订，无须读取值。

Commands 复用 parser、injection 与转义规则；文件/Shell 展开使用稳定 Runtime invocation，
遵守 Hook、审批和持久回执。先保存展开结果再推理，恢复不重复执行。
用户顺序为 UserPromptSubmit、展开、UserPromptExpansion、推理。
模型命令通过 skill 分派并使用独立批次；静态 Skills 保持仅加载指令。
Child launch snapshot 固定父 binding、agent descriptor、工具限制和已配置模型路由，
Java 核对来源成员关系后创建。保留层数、限额、取消、中继，不扩大父权限。

目标依赖预检只检查可直接解析的命令和解释器，不运行 Hook、不连接 MCP。
作者提供的复杂 Shell 表达式仍由真实审批调用检查。嵌套 Shell substitution、
backtick 和 heredoc 中的参数占位符明确拒绝，不在未经证明的转义上下文中插入参数。

Linux owner 停止使用进程树证据。SSH 必须实现启动、按范围配置、排空、退役与恢复，
不能仅翻转布尔开关。原生 macOS 开发者模式默认关闭，只证明登记的进程组已停止。
注册和回执持久保存监管模式。旧证明不能认证新 owner，生产验证器拒绝开发者证明。
只有原 Runtime 协商新合同时才允许 apply。

## 接口、发布与验证

公开、WebShell、SDK 增加 Workspace 包发布/目录/settings/operation 接口，
以及 Session 选择、查询、apply、恢复接口。发布要求 Workspace OPERATOR 加部署来源、
actor 和执行策略。命令使用稳定幂等键与预期配置版本。
状态查询只读，不创建 Session、不冷加载 Harness、不重提操作。
管理 UI 复用界面，使用独立 Managed provider，并取消旧目标请求。
统一 Plugins → Extensions 页签接收当前 Managed provider、Workspace 和会话；
未选择会话时也保留 Managed 上下文，不回退到 daemon 扩展目录。
目录最多包含 256 个包，每个 Session 最多选择 32 个。
只有明确在受理前返回的 `extension_config_revision_conflict` 才清除 pending apply 并刷新配置版本；
通用冲突和未知结果保留原选择及幂等键。

按协议/存储、本地执行、SSH/macOS profile、故障门禁顺序实施。
覆盖跨平台准备、凭据与根隔离、缓存重建、七类组件、应用/停用/移除/恢复、
同 Workspace 会话隔离、基础 MCP/Hook 保留、commit/drain/enable/ACK 丢失、权限和旧记录/profile。
使用真实 MySQL、进程和 SSH 证据，区分 Linux 清理与 macOS 范围。
遵守受影响包检查和 Java 模块共享十分钟本地验证预算；CI 承担完整平台/故障矩阵。
证据记录在 `.qwen/e2e-tests/managed-extension-packages.md`，缺失门禁保持明确。

## 实现与验收

实现包括原始包编译器、耐久 archive/settings API、统一配置账本与屏障、Runtime 组件及
资产接线、公开 child snapshot、SDK 和 Managed WebShell provider。发布与执行仍需显式开启。
普通工具拒绝缺失或漂移的私有缓存；显式 apply 可以校验权威 archive 并重建原私有路径，
不放宽 Workspace 访问。

定向 TypeScript 测试包含两个扩展的真实 MCP/Hook 子进程：读取同名设置，同时看不到
另一扩展的值。原生 macOS worker HTTP 切片覆盖身份核验、上传、激活、只读资产、
file-history 隔离和 Shell。这些测试不证明 Linux 进程树或 SSH 清理。

真实 MySQL/控制面/Hosted Harness/原生 macOS 运行达到初始 active revision 1，
通过 context、静态 Skill 交付、真实 MCP 副作用、Hook 调用和公开审批。
分配的 Java 窗口在 command 展开期间结束；此运行尚未验收 command 完成、child 调用、
更新、补偿及重启不重放。它也暴露了 Hook settings 注入缺失，随后已修复，并通过上述
独立真实进程测试。所选 MySQL 配置及创建用例通过；新增 child 准入用例触发了无效测试策略，
fixture 已修正，但未在本地重跑。

Java 模块共享本地验证预算已用约 596/600 秒。完整 Java/SpotBugs/MySQL、七类组件执行、
Linux/SSH/macOS 清理、权限撤销以及 commit/drain/start/ACK/response 故障矩阵，
仍是必要 CI 门禁。Harness/控制面重启可以重连仍存活的原 Runtime；此增量不宣称透明替换
丢失的 Runtime 进程或主机重启恢复。原 owner 丢失沿用既有 fail-closed 恢复规则，不能重放工作。

现有 CI 会收集新增单元、合同及 MySQL 测试类，但尚未自动化完整包的平台/故障矩阵。
既有静态 `HostedExtensionsIT` 不能替代这部分剩余验收。

## 未决决策

首期已采纳范围没有未决产品选择。不支持的动态语义另行实现激活合同，不能静默扩大本 profile。
