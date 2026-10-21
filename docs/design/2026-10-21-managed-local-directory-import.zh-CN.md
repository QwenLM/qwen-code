# Managed 本机目录导入

[English](2026-10-21-managed-local-directory-import.md) | [简体中文](2026-10-21-managed-local-directory-import.zh-CN.md)

## 问题与范围

目前选择已有本机项目，需要管理员先登记项目父目录，再授予一个 OWNER
Workspace。受信任的本机单用户部署应在用户选择项目时自动完成这些步骤。
已有文件留在原处。本次不涉及 SSH 接入、共享远程部署、标记修复和文件系统沙箱。

## 权限边界

新增 `runtime-broker.local-directory-import-enabled`，默认 `false`。启动时要求
公共监听地址为回环地址、OPEN 认证并配置受信任 actor 头，同时启用 Workspace
文件、持久化 local-process 执行和验证恢复。这是一项显式的本机单用户能力。
独立发布 `localDirectoryImport`，不与已有目录选择、空 Workspace 创建混用。
每次请求仍要求经过认证的 tenant actor。

## 导入生命周期

WebShell Workspace 创建新增可选绝对路径 `localPath`，与 `sourceWorkspaceId`
和 `cwdRelative` 互斥。复用 actor 范围的 `WORKSPACE_CREATE` 回执及幂等键。
提交前冻结请求，结果未知时重试不能改变路径或名称。

对已有项目路径规范化并校验。如果当前 actor 拥有的 ACTIVE ROOT Workspace
中存在包含项目的已验证 LOCAL 根目录，直接复用；否则选择所有祖先 Git
工作树之外最近的项目父目录。拒绝文件系统根目录、保留目录，以及与 Runtime
私有状态或空 Workspace 创建根重叠的目录。登记前，将规范化根目录和原生
host/device/inode/birth 身份写入待完成回执。复用现有受保护的登记流程和 OWNER
授权事务，不复制文件、不替换已有标记。

完成回执为文件访问、工具准入、Runtime 挂载和恢复解析导入根目录；重启或关闭
后续导入后仍然可用。存储保护继续验证标记和物理身份。回执解析不能依赖空
Workspace 创建根。同一根目录使用期间再次导入项目，应复用存储而非重新登记。
首次并发导入遇到尚未完成的登记时可以安全拒绝；重试时，在验证固定物理身份后，
可以复用已经完成的自有根目录。回执重放不得恢复已撤销的授权。

选中的项目成为 `defaultCwdRelative`。与现有目录选择一致，登记的父目录及物理
owner 租约由相关 Workspace 共享；选择子目录不产生文件系统隔离。标记留在
Git 清理范围之外，项目本身作为初始工作目录。

## 浏览器流程与契约

复用已有 Add Workspace 目录浏览器。本机导入模式下，“选择已有目录”直接打开
主机目录，无需先选择获授权的 Workspace。扩展已有目录查询，加入 `localPath`，
与原有 Workspace 相对路径请求互斥。空本机路径从主机用户主目录开始。
目录枚举有数量上限，跳过符号链接、保留及私有路径，并要求本机导入能力。
受限部署保留原有的授权根目录流程。

同步更新 OpenAPI schema、生成的 WebShell 类型、Java 适配器、能力映射、
待处理请求校验及中英文文案。目录查询属于 actor/host 范围；导入后 Workspace
操作使用持久化存储范围，不回退到主 daemon 或 SSH。

## 影响范围

- Java 配置、安全校验和 `WorkspaceDiscoveryController`。
- `WorkspaceCreationStore`、`WorkspaceCreationRoots`，以及
  `WorkspaceStorageGuard` 的存储身份访问。
- OpenAPI、契约测试、Java 集成测试和服务 README。
- WebShell Java provider/client、`WorkspaceBindingCreator`、翻译和专项 UI/浏览器测试。

不需要 schema 迁移或新增回执命名空间。导入根回执要求兼容的 Java 读取端，旧版本
会拒绝读取；Node worker 契约保持不变。

## 验证与验收

1. 未登记父目录时即可浏览并导入已有 Git 项目，得到 OWNER 权限，并在项目中启动。
2. 文件保持原样，登记标记位于工作树之外；文件查询和首次工具 Turn 使用导入根目录。
3. 重试、重启、关闭后续导入、复用第二个项目及首次并发导入保持持久化权限和幂等性。
4. 目录丢失或替换、外来标记、根目录重叠、私有状态、非法请求和授权撤销均安全拒绝，
   不产生新权限。
5. 未启用或向远程暴露的部署不能浏览任意主机路径。原有空目录创建、授权目录选择及
   SSH 保持可用。
6. 执行专项 H2/单元测试、临时 MySQL 8.4 集成测试、Maven 验证、TypeScript
   build/typecheck/bundle，以及桌面和移动宽度浏览器验证。在 `.qwen/e2e-tests/`
   记录基线和结果。

## 状态与开放问题

已实现。原生 macOS 验证覆盖空登记表导入、文件查询、模型 Read 工具、运行中根目录复用、
浏览器重试，以及关闭新增导入后的重启。未在本地执行原生 Linux 验收。专项 Java/MySQL
和 TypeScript/浏览器检查与中断的 Java 全量测试分别记录在 `.qwen/e2e-tests/`。
没有未决产品选择。普通创建回执省略未使用的导入字段，继续支持旧 Java 版本读取。
