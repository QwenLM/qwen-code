# Managed 共享本机项目

[English](2026-10-28-managed-local-shared-projects.md) | [简体中文](2026-10-28-managed-local-shared-projects.zh-CN.md)

## 状态与问题

基于 `149d577ed6` 的本地实施方案，验证结果记录于下文。当前本机导入把项目父目录登记为物理存储根，并在其中发布唯一的 `.qwen-managed-storage.json`。独立本机实例使用不同的 catalog 和身份，因此第二个实例拒绝已有标记。停止启动器既不会移交登记，也不证明其持久 worker 已停止。

目标是让受信任本机实例使用同一已有项目，无需接管父目录。各实例继续管理自己的 catalog、进程和分配的 worktree。本后续改动与主会话 worktree 支持一起纳入 PR #15745。

## 登记与布局

新建绝对本机路径导入使用不透明存储 ID `imported-<receipt key>`。已有 `created-` 回执（包括早期本机导入）保留当前语义和标记位置。新前缀必须解析到有效的 actor 范围创建回执，并包含固定的 `localRoot`；仅有前缀不能授权路径。不新增 schema migration 或公开请求字段。

项目父目录继续作为共享布局及导航边界。主会话和子任务 worktree 保持相对存储根的路径，位于源 Git 工作树外。选择项目仍设置其相对工作目录；这不引入项目文件系统沙箱，也不对父目录声明全局独占归属。

新导入存储的登记元数据位于 `<runtime state directory>/imported-projects/<storage ID>/.qwen-managed-storage.json`。这些规范化私有目录属于当前实例。登记不创建外部根的全局标记，不读取它来判断归属，也不替换或删除它。已有全局标记与项目文件均保持原样。

catalog 仍保存原始 host/device/inode/birth 身份及当前实例的登记。源目录替换、私有元数据丢失、回执损坏、授权撤销和未知绑定继续拒绝。已完成请求重放不重建丢失元数据，也不恢复授权。关闭新增导入能力不影响已有导入根。

## 执行与维护

`WorkspaceCreationStore` 分配新存储身份，`WorkspaceCreationRoots` 解析身份及私有元数据。`WorkspaceStorageGuard` 在登记、普通及加锁校验、文件根、检查及探针校验中使用这些元数据。`WorkspaceExecutionStore` 保留现有 catalog 内准入和租约检查，并拒绝新共享存储的独占 rewind。LOCAL Runtime 与文件协议不变；SSH bootstrap 及 CSI 不使用此行为。

两个实例可以编辑同一导入项目，承担与多个独立终端相同的普通编辑冲突。本改动不引入跨实例独占写入或物理恢复保证。需要隔离编辑时继续使用独立 worktree。

主会话/子任务 worktree 准备、精确路径清理及已停止操作对账继续使用各实例记录的 ID 和身份，不枚举、prune 或删除其他实例的 worktree。维护占用仅协调本实例的执行。

整存储 fencing、物理快照/恢复、文件历史 rewind 及存储迁移要求独占权限；新共享导入在改变存储状态前返回 `workspace_shared_directory`。在存储 guard 的 fence、恢复登记、已捕获登记校验、还原及迁移入口拒绝。实例自身进程的 Runtime 恢复仍可使用。应用自有根、显式配置的挂载、旧导入及部署型 SSH/CSI 保留原有保护。

## 兼容性与范围

持久本机执行已要求的 runtime state directory 同时保存导入元数据，必须与 catalog 一起保留。旧 Java 读取端拒绝新存储前缀，不会静默按自有根处理。不自动迁移、修复或重写已有回执和磁盘标记。

本次不把 worktree 容器搬到第二个挂载，不缩小现有父目录导航授权，不重做待确认创建的界面，不协调任意外部编辑器，也不改变部署认证。项目内容根与独立私有 worktree 挂载需要更大的后续改动。

## 验证与验收

使用不同 catalog 和私有状态目录导入同一个真实项目：两边均成功，项目内容不变，已有外来全局标记逐字节不变。验证已完成重放、重启/关闭新增导入后的访问、私有元数据缺失或篡改、源目录替换以及 actor/tenant 拒绝。旧登记及应用自有根的标记拒绝保持有效。

执行普通文件解析、主 worktree 创建/清理及实例元数据独立性检查。整根维护应拒绝，不推进操作状态或修改文件。选择受影响的 H2/单元及真实 MySQL 8.4 用例，并执行真实进程的本机启动/导入链路。当前请求的本地 Java 检查共享一个 600 秒预算；完整支持平台、故障及静态分析门禁留在 CI。分别记录失败尝试和缺口。

### 已记录的本地结果

未修改基线复现了冲突：实例 A 导入成功，实例 B 返回 `workspace_unavailable`。全局安装的 CLI 为 0.24.1，不支持 Managed，因此基线使用生产 Java 类、原生 Git 和独立 H2 catalog。

本地实现的 54 个创建、存储 guard、共享导入及 worktree store 专项单元/H2 用例在专项运行中均通过。MySQL 8.4.11 的三个专项用例通过：独立 catalog 及外来标记保留、旧回执续办和独占维护拒绝。原生 macOS MySQL 实例关闭二进制日志；Linux 专用 native-AIO 设置不适用。Java 打包和 Checkstyle 通过。

两套真实 `serve --managed` 使用修改后的 Java payload 和未修改的已构建 CLI，分别导入同一个测试项目、重放请求、浏览文件并返回支持 worktree 的选项。另一个生产 Java/原生 Git 探针准备两个隔离 worktree，拒绝脏目录清理，并清理其中一个而不改变另一个 checkout、私有元数据或外来全局标记。任务自有服务及测试目录已清理；用户正在运行的演示实例和真实 Projects 目录保持原样。

首次专项运行暴露了两个新测试的夹具/预期错误，并非产品失败：已完成回执重放返回持久化 Workspace，不重新登记丢失元数据；构造旧回执时必须单独写入 `result_json`，不能作为 `previousStatus` 传入。二者修正后重跑受影响用例。后续 Checkstyle 发现 import 分组缺少空行，修正后打包/样式检查通过。失败日志保留于本地测试产物。

这些结果仅证明所选原生 macOS 路径。后续改动未执行模型 Turn、浏览器交互、进程重启/故障恢复、Linux 执行、完整 MySQL/Hosted profile 和完整静态分析门禁。必需 CI 验收仍待完成，不使用早期 PR 或设计证据代替这些缺口。
