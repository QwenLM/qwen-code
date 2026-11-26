# macOS 上的 Managed Workspace 执行

[English](2026-10-17-managed-macos-local-runtime.md) | [简体中文](2026-10-17-managed-macos-local-runtime.zh-CN.md)

## 问题与当前行为

Java Managed Agent 已能在 macOS 上提供文本会话，但 Workspace 工具必须绑定已注册的物理存储所有者。注册读取器只接受 Linux，并读取 `/etc/machine-id`。持久化本地 worker 也依赖 Linux 的主机、启动期和命名空间身份。关闭这些检查不会产生执行所需的物理存储注册。

本次目标是在这台 Mac 上使用现有的本地 Node.js 工具 worker，支持模型、审批策略选择和真实注册的 Workspace。保留 Java 控制面、SQL 权威、Hosted Harness 和 Runtime Broker 的职责边界。

## 方案

增加一个由存储注册和持久化 worker 身份共用的小型 macOS 主机身份读取器。使用固定的 `/usr/sbin/ioreg` 命令读取硬件 `IOPlatformUUID`，使用 `/usr/sbin/sysctl -n kern.bootsessionuuid` 读取当前内核启动期 UUID。限制命令时长与输出大小，拒绝缺失或格式错误的 UUID，只缓存不变的硬件身份。不记录原始身份值，不提供可配置的探测命令。

Workspace guard 保留 JDK 的规范目录、设备和 inode 检查。macOS 另外通过一次受限的 `/usr/bin/stat` 快照读取精确出生时间、设备和 inode，并交叉核对两次原生身份。JDK 21 会将 macOS 出生时间截断到秒，因此不能作为该身份来源。以整数解析原生秒与纳秒。macOS 原生出生时间为正时，即使等于 mtime 也仍是独立字段，与 CLI 现有的 macOS 存储读取器一致。跳过仅用于 Linux 的创建变通处理，即把 mtime 设到 epoch 后 1 ms；Darwin 会连带将出生时间移到过去。macOS 沿用 marker v2 和应用专用 HMAC 身份，以硬件 UUID 作为密钥输入。Linux 的注册字节、备用出生时间拒绝和身份派生保持不变。缺失注册或原生出生时间、根目录替换、marker 变化、目录重叠和所有权检查仍然拒绝准入。

持久化本地 worker 选择原生主机身份。Linux 保留当前的主机、启动期、PID 命名空间和时间命名空间值。macOS 使用规范化硬件 UUID、内核启动期 UUID，以及显式的 `macos` 命名空间标签。已有 `ProcessHandle` 启动时间匹配提供 macOS worker 进程身份。重新核验原 worker 前，保存的 handle 必须匹配同一主机与启动期；worker 死亡不允许重放或替换。

本次支持 macOS 同一启动期内的 Broker 重启接管。可信整机重启恢复仍仅支持 Linux：macOS 部署必须设置 `trusted-local-reboot-recovery=false`。本地冒烟测试不证明整机重启、克隆磁盘或跨机器恢复。

## 影响组件

- Managed Agent 存储 guard 及其原生身份测试。
- Runtime Broker 的 macOS 原生身份读取器、本地 worker 身份选择及测试。
- Managed Agent 配置与运维 README。
- 保存在仓库之外的本地开发配置，用于注册和授权 Workspace，并将 Broker 接入 Hosted Harness。

无需修改公开路由、SQL schema、marker 版本或 TypeScript 合约。不增加伪造注册、绕过模式或回退到普通 daemon 工具的路径。

## 决策与约束

使用 JDK 进程和文件系统 API，以及已有 Commons 摘要工具，不增加依赖。保持 Linux 身份和恢复行为兼容。对不支持的平台和不可读的原生身份明确拒绝，不能用主机名、随机身份或可变路径代替权威身份。私有运行状态和存储 marker 放在 Git worktree 之外；项目作为已注册存储根目录下的工作子目录。

macOS handle 的命名空间标签会让旧读取器明确拒绝。保留 macOS worker 前先部署更新的 Java 读取器，并在同一启动期重启时保留状态目录、数据库和凭证密钥。Shell 和文件操作继续遵守现有审批合约。

## 验证与验收

1. 实现前记录全局 CLI 行为和现有 Java 注册拒绝。
2. 单元测试覆盖原生 UUID 解析、探测不可用、平台拒绝、同一启动期身份和现有 Linux 格式。真实 macOS 测试与独立 Node bigint lstat 比较注册的精确出生时间，注册空根目录、跨 guard 实例校验，并拒绝携带原 marker 的替换根目录。
3. 执行受影响的 Java 测试、`mvn verify`，以及独立一次性数据库上的 MySQL 集成 profile。执行适用的本地 worker 测试；本机无法运行的 Linux Hosted/故障 profile 明确记录为不可用，不宣称完成验证。
4. 离线注册本地存储，授予开发 actor 权限，再通过真实 WebShell 和模型读写唯一测试文件。检查磁盘字节、审批处理、模型选择和后续 Turn。通过受控本地测试验证同一启动期 worker 接管。
5. 完成连续两轮干净自审和独立代码评审，保留可用的本地服务供用户调试。

## 未决问题

本次范围内没有未决问题。macOS 整机重启恢复和其他操作系统需要单独验证。
