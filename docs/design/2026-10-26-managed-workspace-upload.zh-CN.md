# Managed Workspace 文件上传

[English](2026-10-26-managed-workspace-upload.md) | [简体中文](2026-10-26-managed-workspace-upload.zh-CN.md)

## 问题与范围

Managed WebShell 已支持随消息提交文本和图片附件，以及引用 Workspace 内的小文本文件快照，但不能把浏览器文件上传到持久 Workspace 存储。现有文件服务通过有界 CLI bootstrap 访问已登记的 LOCAL 和 SSH_LOCAL 存储；CSI 文件访问尚不支持。

为这两种已有存储补齐上传，支持空文件和二进制文件，单文件上限 8 MiB。复用输入框的文件选择、拖放选择、进度与错误展示、取消和 Session 切换保护。文件写入当前工作目录或正在浏览的已有目录。目标已存在时返回冲突，绝不覆盖。文件夹上传、自动创建目录、CSI 和对象存储服务不在本次范围内。

上传要求没有尚未释放的 execution-storage 成员。普通 Turn 结束后会释放成员；持久 MCP Runtime 可能仍保留成员，因此返回 `workspace_busy`。本次不会放宽这条所有权边界，也不会用 Session 表面空闲来证明工具进程已停止。

## 归属与 API

新增 WebShell `POST /api/agent/web-shell/v1/workspaces/files/upload` 接口，归属于持久 Workspace。查询参数为 `workspaceId`、`cwdRelative`、`path`、`expectedScopeRevision` 和 UUID `uploadId`，请求正文为 `application/octet-stream`。接口要求可信 actor 拥有 OPERATOR 或 OWNER 权限，并已启用 Workspace 文件访问。服务端校验登记的存储身份与修订，绝不回退到 daemon 的主 Workspace。二进制正文受硬性大小限制。同一上传 ID 的相同请求只对账原命令；请求内容改变则返回冲突。

响应包含 `scopeRevision`、`uploadId`、`path`、`sizeBytes` 和 `sha256`。Workspace 文件查询仅在所选 CLI 支持独立的 `workspaceFileUpload: 1` 握手时公布可选 `maxUploadBytes`。旧部署继续支持文本引用，上传保持禁用。OpenAPI、生成的客户端类型、surface registry 和能力映射同步更新。

## 持久准入与恢复

短 SQL 事务在现有操作账本登记 `WORKSPACE_UPLOAD` 并取得物理存储 owner hold，冻结 actor、请求摘要、ContextBinding、存储身份和原始 bootstrap 目标；二进制内容不存入 SQL。现有工具执行、存储 fencing 和退役必须尊重这个 hold。子进程和 SSH 调用都在 SQL 事务外执行。确认完成或明确失败后，只释放本操作的 hold；超时、响应丢失或控制面重启时保留占用，直至原命令完成对账。

Runtime 在配置的私有状态目录下按 `uploadId` 保存仅 owner 可访问的回执。写入前原子认领操作并记录原始 PID，所有文件变更和临时文件清理结束后才发布终态回执。对账绝不执行上传：返回终态回执、保守等待仍存活的原进程，或在明确确认原进程不存在后检查原目标的大小与摘要。如果尚无 claim，对账会原子发布失败墓碑，阻止迟到的原命令开始执行。PID 复用可能延迟对账，但不能授权重放。未知结果不会通过替换 Runtime、重复写入或回滚删除来处理。

## Runtime 文件系统边界

沿用 bootstrap 对允许根目录、存储身份和工作目录的校验。上传请求使用协议版本 1，操作为 `upload` 和 `upload-status`，字段包含 `uploadId`、相对 `path`、`sizeBytes`、`sha256`，仅上传携带 base64 `data`。响应的 `state` 为 `completed | failed | pending`；失败终态包含 `code`。上传输入使用独立的有界传输限制，不扩大普通 bootstrap 和响应的 64 KiB 限制。

复用规范化相对路径校验与目录身份检查。拒绝符号链接、目录穿越、Managed 保留路径和特殊文件。先写入仅 owner 可读写的临时文件并同步，复查目录锚点，再通过原子、不覆盖的硬链接发布。已有路径绝不被覆盖。发现路径或存储身份变化时拒绝。这些检查沿用 Node 文件系统已有的竞态限制，不宣称提供 `openat` 沙箱。

## 输入框行为

向共享输入框显式提供 Managed 上传目标，不因此启用其他 daemon 功能。目标身份包含 provider、Workspace、工作目录、修订和 Session。旧目标的上传完成后不能向当前草稿插入引用。已有定制开关仍可禁用上传。

上传成功后插入带作用域的路径引用。发送时 Managed 适配层校验其作用域，并把相对路径放入模型输入；不会把二进制内容转换成文本附件，也不会调用小文本快照 API。已有文本引用继续保留不可变快照行为。取消浏览器请求不承诺删除已经提交的文件；不确定结果按原上传 ID 对账。

## 验证与验收

- 基线：全局 CLI 缺少上传握手，Managed 菜单无法上传到 Workspace 存储。
- Runtime：二进制和空文件精确字节、8 MiB 边界、已有文件、嵌套与 Unicode 路径、符号链接与穿越、存储身份变化、并发和重复 ID、终态回执以及崩溃和迟到命令对账。
- 控制面：actor 与租户隔离、角色、过期作用域、禁用与不支持的存储、持久 hold、工具执行与 fencing 并发、请求变化、未知结果、原目标恢复以及响应大小和摘要校验。
- UI：能力启用路径、旧能力禁用路径、二进制引用、上传失败、目标切换和原有文本快照。
- 执行定向包测试、根目录 build/typecheck/bundle、OpenAPI 契约和 surface 门禁，以及 Java 模块共享十分钟本地验证预算内的定向检查。SQL 和并发案例需要真实 MySQL 证据；未运行的 SSH、CSI、Linux 或真实模型路径必须明确保留为验收缺口。

控制面、CLI bundle 和 WebShell 均已实现。根目录 build/typecheck/bundle、定向 TypeScript 与 Java 测试、契约与 surface 门禁、Checkstyle 均通过。Java 定向运行覆盖 99 个不同案例；新增上传测试还在一次性 MySQL 8.4.11 上通过 10 个案例。初轮 Java 环境准备、检查与清理使用 569 秒；审查后追加的回归、直接编译和样式检查仍在同一共享 600 秒本地预算内。独立审查发现 stdin writer 与 stdout reader 争用 common pool 时会阻塞；独立 JVM 复现了超时，改用虚拟线程后，原 probe 和永久 fork 子进程回归均通过。复查未再确认其他缺陷。

实际 LOCAL Runtime bundle 通过 15 组 smoke 检查（27 次子进程调用）。早期 Chromium 使用真实 UI 和 Runtime bundle、受控 Java HTTP 响应，通过五组检查，发现并验证修复了已有 Session 提交时丢弃文件路径文本上下文的问题；这部分证据仅覆盖受控 HTTP 环境。

同步主干 `338f13366c` 后，根目录 build/typecheck/bundle、452 个定向 WebShell 测试、267 个定向 CLI 测试、92 个定向 Java 测试、可执行 Server 打包和 Checkstyle 均通过。一次新的 MySQL 8.4.11 案例初始化当前完整 V1 基线，并验证原进程 hold 拒绝第二次上传及物理 fencing。用户明确为本次部署工作追加了 30 分钟共享 Java 验证预算。

真实 `qwen serve --managed` 使用隔离数据目录、Gateway 到 Java 的签名请求、新 H2、Hosted Harness 和正式构建的 LOCAL Runtime，全程没有 HTTP 拦截。十组 API 检查通过二进制/空文件/8 MiB 上传、超限拒绝、不覆盖与幂等结果、路径安全和独立 actor/租户隔离。Chromium 通过完整应用的实际菜单完成上传，并以带作用域的纯路径输入提交新 Session。配置的 Kimi Turn 在 150 秒内没有 assistant 或工具结果，已取消，不能宣称真实模型读取通过。受控重启后，四个已完成上传的回执、磁盘摘要和作用域修订均保持一致。原 Session 随后需要 operator recovery，上传菜单按该失败边界禁用，因此本次部署没有验证该已有 Session 的二进制提交。

远端 SSH、Linux、真实模型读取、上述 Session 的恢复及完整 Java/Hosted/故障 CI 门禁仍待验收。CSI 仍不支持。部署时需要同步更新 Server、CLI 和 WebShell；按正式发布前的 schema 策略，本次 V1 基线变更后需重建开发数据库。
