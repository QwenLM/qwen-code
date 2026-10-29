# Managed Workspace 文件引用

[English](2026-10-19-managed-workspace-file-references.md) | [简体中文](2026-10-19-managed-workspace-file-references.zh-CN.md)

状态：已实现；验收证据与已知限制在本地 E2E 报告中记录。

## 问题与当前行为

Managed 输入框支持有界浏览器附件与 Plan，但关闭了普通 daemon Workspace actions。
因此，本机和 SSH Workspace 的 Reference file 都没有 provider。直接打开普通 actions
会访问 daemon 的 Workspace，不一定对应已经持久化的 Managed 绑定。

已有目录选择接口只列出 actor 拥有的本地 ROOT Workspace 的直接子目录，排除 SSH
和 CSI，也不读取文件。现有 Managed 输入已经持久化完整 UTF-8 附件，对全部字节
计算摘要，并在投递未知时重放同一份 canonical 输入。

## 目标与范围

支持浏览、按文件名搜索、选择 UTF-8 文件，并从本机或 SSH Managed Workspace
提交其选择时的完整内容。覆盖首个 Session 创建前和已有 Session 的输入框。
界面和 HTTP 契约独立于机器地址及传输实现。

结果为文件快照：选中后修改源文件，不改变草稿或已准入 Turn。后续实时读取继续
使用已有文件工具。本次不接静态 Skills、MCP、Extensions、目录附件、二进制文件、
大文件存储或 K8s/CSI adapter。

## API 与授权

query 和 read 均要求部署开启已有的 Workspace files 开关，返回数据前也复核此开关。

新增 Workspace 范围的 WebShell query 和 read 接口。请求指定 Workspace 和相对
工作目录。query 接收相对目录或有长度限制的文件名搜索词；read 接收一个相对文件
路径及 query 返回的 scope revision。响应包含相对路径、有界条目或 UTF-8 正文，
以及不透明的 scope revision，不含宿主路径、SSH 目标、Pod、Runtime 凭据或租约标识。

每个请求要求受信 tenant/actor、当前 OPERATOR 或 OWNER 权限、ACTIVE Workspace、
受支持存储及已启用的 Workspace 文件访问。服务端从持久 Workspace 推导 generation、
storage、配置和执行位置。scope revision 覆盖这些绑定事实、cwd 与登记身份，过期
revision 拒绝读取。

文件 I/O 前后分别用短事务解析授权。后一次解析必须保持相同 scope 和当前授权。
本地进程和 SSH 不在数据库事务内执行。登记、维护、迁移、恢复和移除屏障继续有效。
查询不取得或释放 Runtime/storage 执行租约，不创建 Session、worker、Hook 或模型请求。

该接口属于持久 Workspace 范围。已有 Session 的界面传入保存的 Workspace/cwd，
并在 context revision 变化时重置发现。Workspace、cwd、tenant、actor 或 Session
变化后，必须拒绝提交原选中文件快照；保留可见草稿并提示重新选择。

## 文件访问边界与适配

Java Workspace 文件服务后保持一份内部 query/read 文档及响应形状，按保存的
storage kind 选择实现。本机 adapter 使用配置的 Node executable 和 CLI entry，
进入独立、有界、只读的 fast path。SSH adapter 复用现有认证 SSH bootstrap 传输，
JSON 经 stdin 传送并严格检查主机密钥。两者调用同一 TypeScript 文件查询实现。

两种传输先调用 `managed-runtime-bootstrap --help`，只接受带版本的 `workspaceFiles: 1` JSON 能力声明。新 CLI 在读取 stdin 或初始化 Runtime 前返回；旧安装输出普通帮助，服务端在发送实际操作前拒绝。已验证全局旧 CLI 的此帮助路径不消费 stdin，也不调用模型。握手后，已有 `probe` 操作接受带版本的 `files` 子文档并返回 `result.files`。缺失或无效的协议结果明确失败，不把未知命令当成提示执行，文件 probe 不进入 Runtime 状态初始化。

本地登记和 marker authority 仍由 Java storage guard 负责，向子进程传入已验证的
root 及其身份，并在返回前再次验证。本地 marker 权限不必满足更严格的 SSH 私有
状态文件契约。SSH 验证原持久 identity 和私有 marker、检查固定的 CLI 版本，
并在创建 Runtime state directory 的分支之前返回。

未知、CSI 和不支持的 placement 在访问本地路径前明确失败。未来 K8s adapter
经解析后的 Runtime/storage 绑定提供同一 query/read 契约，负责验证挂载身份及
Pod 替换后的恢复。本次不增加空 K8s 实现，也不回退到主 daemon。

控制面最多允许四个并发文件交换，超出时返回可重试的繁忙响应。本机进程限时 15 秒；SSH 保留已有的有界命令传输。

## 路径、限额与文件系统信任

只接受规范的相对 POSIX 路径。拒绝绝对路径、目录穿越、反斜杠、控制字符、非法
Unicode 和保留维护路径。排除 `.git`、`.qwen-child-workspaces` 和 Managed storage
marker。拒绝路径分段和文件中的软链接、作为附件的目录以及特殊文件。

使用 `O_NOFOLLOW | O_NONBLOCK` 打开读取，并在读取前用 fstat 确认普通文件。
最多读取 24 KiB，以 fatal 模式解码 UTF-8，拒绝 NUL 和空正文。I/O 前后检查 root、
祖先和文件身份/属性。变化或不可用的文件返回不含绝对路径的类型化错误。

query 最多返回 50 条，扫描至多 4,096 项和 32 层目录，并检查两秒扫描期限。
搜索匹配文件名/相对路径，不搜索内容。同时限制序列化响应并明确 truncated。
快照响应经 JSON 编码后必须在 48 KiB 内，绝不静默截断。SSH 独立的 64 KiB
信封上限保持不变。

本机与 SSH 执行保留现有的可信主机/账户假设。macOS 上 Node 按名称访问文件系统
的 API 不提供相对目录描述符的 `openat` 遍历。祖先和描述符检查能发现普通替换及
静态软链接，但不能建立对同 UID 恶意进程主动瞬时替换并恢复路径分段的隔离。
本次不声称具有这种沙箱能力，也不引入 native/Python Runtime 依赖。

## 输入框与持久输入

所选文件仍在加载时，输入框禁用发送；即使 chip 尚未插入，新提交也会拒绝。不完整的选择不能被准入为纯文本 Turn。

新增范围受限的 Managed 文件 actions adapter，复用共享 Reference file picker 及
其请求取消/过期响应处理。仅提供文件 actions，其他菜单保留独立能力。
不支持与空结果明确区分；读取失败保留草稿。

选择文件后先获取快照，再插入 chip。完整正文、路径和源 scope 保存在 metadata 中。
若读取内联引用期间草稿发生变化，保留编辑后的草稿，丢弃过期插入并提示重新选择文件。
Managed 输入框显式启用带版本的草稿信封，原子保存文字及完整文件 tag（含 inline
位置），重新挂载时恢复 tag；兼容旧纯文本草稿，普通输入框的持久化行为不变。
移动端复用已有的 top-tag fallback 恢复 inline 引用，只移动已知引用范围的文字并保留
metadata；接收输入或显式清空时，在离开页面前同步清除保存的 tag 状态。
提交提取有效的选中文件 annotation，检查当前源 scope，再将快照转换为现有
`input_file`。快照摘要计算后及异步附件编码后，在保存或准入新请求前再次核对源。
有界的 `input_text` 映射保留相对路径并区分同 basename
文件，不改变原文件字节。仅键入形似路径的文字不会授权或触发文件读取。

复用现有附件归一化、完整字节摘要、完整 pending 请求持久化及总计 48 KiB 编码
输入预算。在命令准入前固定全部字节，重试不重新读取源文件，只经现有 composer
commit 回调清除已接收输入。浏览器可以像上传附件一样编辑自己的输入；快照
metadata 不是授权凭证，文件读取授权由 read API 强制执行。

Plan 可像接收上传文本附件一样接收所选文件正文，不获得执行权限，也不改变 Plan
工具白名单或人工退出审批。本次无需新增 InputBlock 类型、数据库 schema、服务端
快照表、模型工具或后台索引服务。

## 影响组件

| 组件                                             | 改动                                       |
| ------------------------------------------------ | ------------------------------------------ |
| Java Workspace/store 和 storage guards           | Scope 解析、adapter、授权和绑定复查        |
| WebShell controller、OpenAPI 和 surface registry | Workspace 文件 query/read 契约及生成 types |
| CLI fast paths 和 SSH bootstrap                  | 共用有界只读文件系统实现                   |
| 共享输入框和 Managed provider                    | 窄文件 actions、快照选择、草稿与提交接入   |
| 测试与文档                                       | 隔离本机/SSH、API、重试与界面验收          |

## 验证与验收

先用全局 CLI dry-run E2E 计划。使用一次性数据库、root、SSH state 和服务端口，
不对用户实际 Session 做测试，也不重置本地部署 catalog。在独立部署验证构建产物。

验收要求真实本机与 SSH 查询和快照、Managed 模型请求中的真实选中文件字节、
新建/已有 Session 界面选择、草稿刷新和源文件变化后的精确 pending 重试、同 basename
映射、Plan 与普通附件回归，以及明确的超限/非法文件错误。验证 tenant/grant 隔离
和撤权、过期 generation/context、marker/root 替换、软链接、特殊文件、扫描预算、
不支持的存储与无本地回退。断言 query/read 不创建 worker、Session、租约或 Hook。

运行定向 TypeScript/Java 测试、根 build/typecheck/bundle、Java verify、API/surface
gates、适用的隔离 MySQL 测试、格式检查、两轮干净自审及独立评审。如实记录 skip
和不可用平台。这些检查不代表 K8s、恶意同 UID 沙箱、完整 Hosted/fault 或真实上游
模型验收。

## 开放问题

本范围没有待定项。空文件继续遵循现有附件契约，明确不支持。未来实时引用和 K8s
adapter 分别需要实现与验收证据。
