# K2 原宿主 peer 连续性

[English](2026-10-17-k2-host-peer-continuity.md) | [简体中文](2026-10-17-k2-host-peer-continuity.zh-CN.md)

状态：#13395 与 Draft PR #13526 的实现候选。扩展[出生设计](2026-10-16-k2-pre-exec-birth.zh-CN.md)，不授予释放权限。

## 问题与范围

runtime、CSI backend、kubelet、registrar 当前持有 pidfd 和可执行文件，但后续进程检查仍通过全局 PID 路径。它们未将实际 enforce label 与受保护安装 target 比较，也未持续持有原 user/mount namespace。gateway 核对当前线程 credentials 与 label，但没有持续持有的 namespace 基线。

## 实现

从既有已验证工件快照提供闭集宿主可执行文件值。核对字面绝对路径、hash 及各不相同的受限 label；复制值，不返回可变 map。runtime/plugin dialer 与两个 frontend handshake 角色直接消费这些值。

持续持有原 proc 目录、executable 与 pidfd，通过该目录读取有界 stat 和 AppArmor 项。实际 executable 路径、digest、enforce label 必须匹配所选 target。每次 namespace 比较前后，核对原进程仍活着且 executable 未变。持续持有 user/mount namespace 描述符，将 NSFS/type/device/inode 与当前固定 proc 项比较。要求支持范围内的初始 user inode 不变量及完整初始 uid_map。任何失败永久使该 peer 失效，不为失败或替代进程更新基线；初始化部分失败和关闭均回收所有描述符。

gateway 启动时持续持有原 leader 的 namespace 对。每个既有 control 边界除原 credentials/profile 检查外，还将 leader 与当前锁定 OS thread 的 namespace 与该对比较。namespace 错误永久拒绝。仅向 gateway profile 增加固定 user/mount proc 叶子，不增加 namespace 修改权限或宽泛 ioctl 许可。

## 限制与验收

宿主 peer 只采样 leader，gateway 另采样当前线程；这不证明所有线程，也不证明间隔中无迁移。私有 mount namespace 无需与其它角色相同。source/7 wire、SQL schema、物理进度状态、释放/复用门均保持原语义。有效 service 配置、宿主反向策略、独占 CSI 接线和可信安装 provenance 仍需完整 consumer 与资格化，才能启用四行释放事务。

用可移植的工件 bytes/MapFS 测试核对闭集宿主 target 与值复制语义。对实际 Linux source、shim、assembler 分别编译 amd64/arm64，不执行产物。静态审查所有调用点与 FD 所有权。原生 namespace/label 修改拒绝、已加载 AppArmor/nsfs ioctl 权限、继承 seccomp 及生命周期资格仍未验证。不通过其它执行器重跑受限原生组。binary 或 generator 改变都要求重新形成安装 pins，旧资格不转移。
