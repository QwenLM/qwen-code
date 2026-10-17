# K2 实际 snapshotter 根目录

[English](2026-10-18-k2-snapshotter-root.md) | [简体中文](2026-10-18-k2-snapshotter-root.zh-CN.md)

状态：#13395 与 Draft PR #13526 的实现候选。

## 问题

target 声明了固定 overlay snapshot 目录，但 artifact validator 尚未检查或保留它。
CRI Status 确认选定的 snapshotter 名称，不说明实际根目录。固定 containerd v2.3.4
的 overlay plugin 可独立于 containerd 根目录覆盖这个路径。

## 实现

验证并保留 target 的准确
`/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots` 值。
gateway 将此保留值和同一认证、持续持有的原 containerd 连接上的 introspection client
传给既有生效配置 guard。不新增连接或后台任务。在 RPC 前拒绝空或不支持的期待根目录。

在既有五秒验证期限内，先读 CRI Status，再对 type `io.containerd.snapshotter.v1`、
ID `overlayfs` 调用无 options 的 PluginInfo。要求准确 plugin 身份、无初始化错误、
无额外响应、响应不超过32 KiB，且 exports 仅含 `root`。exported root 必须准确等于
声明 snapshot 目录的父路径；不清理、解析或接受等价路径。

固定 overlay initializer 发布的 root 与传给 NewSnapshotter 的值完全相同，后者使用
其 `snapshots` 子目录。PluginInfo 直接读取具名 plugin，不经过 Plugins 列表缓存。
固定 proxy registration 总会加入 `address` export，即使为空，因此拒绝这个字段，
不能相信 proxy 调用方自报的 root。这项窄检查不证明未知厂商构建具有相同实现。

服务启动前和既有 control 两侧都消费此检查。Status、PluginInfo 或语义检查失败后
guard 永久拒绝。既有 source 消费者和已启动 worker 轮询继承此检查；sandbox-only
间隔仍无新增周期检查。保留原 peer、受保护文件、unit、namespace、策略和出生检查。
这是采样 metadata 校验，不形成新的安装或释放 authority。

## 验证及剩余边界

普通数据测试必须拒绝一致重算 pins 后的空、缺失或改变 target root，并在调用方输入
改变后保留原有效值。惰性 protobuf/client 测试覆盖准确请求身份、root 不匹配、proxy
exports、初始化错误、缺失/额外/超界响应及永久失败。独立 test-engineer 验证此数据
边界以及同连接的启动/control 消费者。实际 Linux source/shim/assembler 对两个架构
仅编译、不执行；运行 root build/typecheck/bundle，并对完整增量自审两遍。

本轮不运行 renderer、image、parser、Linux runtime 或此前受限验收组。真实目标
PluginInfo/启动、文件系统对象及挂载身份、NRI、宿主反向策略、独占 CSI actor 和安装
provenance 仍未资格化。不改变 source/7 或 Java/SQL 格式，不引入最终物理 writer、
已释放回执读取或后续周期复用。
