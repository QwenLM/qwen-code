# K2 实际 CRI 运行时配置

[English](2026-10-17-k2-effective-runtime-config.md) | [简体中文](2026-10-17-k2-effective-runtime-config.zh-CN.md)

状态：#13395 与 Draft PR #13526 的实现候选。

## 问题

受保护配置字节不能说明原 containerd CRI 服务实际加载了什么。gateway 已持有认证后的
原运行时连接，但尚未读取生效配置。在接受 gateway 身份、创建 metadata 或任务观察前，
需要核对专用 shim 路径及当前狭窄创建通道。

## 实现

通过同一持续持有的连接调用 CRI Status，设置 Verbose=true。固定 upstream containerd
v2.3.4 将服务实际 Runtime Config 序列化为 Info["config"]。要求准确的 RuntimeReady
条件和唯一明确的 qwen-k2-runc-v1 handler；在固定上限内允许无关条件、handler 和
Info 项。handler 名单本身不证明 shim 身份。

核对 builtin runc runtime type、固定 custom shim 路径、准确的三个 runc options、
显式 overlayfs snapshotter、podsandbox controller、空基础 spec、无 annotation
透传或可写 cgroup，以及支持范围内的默认 CNI override。io_type 接受空或 fifo：
固定上游的正规化逻辑可能仍在 runtime map 中保留空值。annotation array 接受 null
或空数组，因为 nil slice 会序列化为 null。拒绝未知 handler/options 字段、错误大小写、
重复 JSON key、必需值缺失、类型转换、无效 UTF-8、尾随 JSON、深度超过64或配置超过1 MiB。

disableApparmor、enableSelinux、enableCDI、enableCRIU 和
enableExperimentalRestoreViaCreate、netnsMountsUnderStateDir 必须显式为 false。
特别是 CDI 或 CRIU 的 null pointer 不代表关闭。将固定 containerd endpoint、root 和
CRI root/state 目录与当前支持通道的字面路径比较。这属于固定布局检查，不是从已安装
Snapshot 读取并证明 namespace/root 身份。离线 fragment 提供这些设置及显式 snapshotter，不安装它们，
也不修改现有 daemon。

[Snapshotter 根目录检查](2026-10-18-k2-snapshotter-root.zh-CN.md)另通过同一连接消费独立校验的 target snapshot 目录和准确 builtin overlay PluginInfo。仅接受 root export，排除固定上游 proxy producer。两次查询共用五秒期限，plugin 响应上限为32 KiB；这不证明挂载或文件系统对象身份。

生产检查器使用一个 mutex，首次失败后永久拒绝。Status 设置五秒期限和1 MiB gRPC
接收上限。服务启动前检查一次，再由既有 gateway control wrapper 在操作两侧消费。
Source 身份、ARM、birth、CSI 和已启动 worker 的后台轮询通过原 gateway 连接消费该
wrapper；sandbox-only 阶段的轮询提前返回，不增加周期检查。
保留 peer 连续性、service/unit 检查及真实出生输入，不以配置相等替代，也不新建连接。

## 验证及剩余边界

可移植的惰性 protobuf/JSON 测试覆盖两种允许的上游表示、每个检查字段、缺失/null/
错类型、别名、重复 key、大小及深度上限、readiness 和 handler 歧义。实际 Linux
source、shim、assembler 在 amd64/arm64 仅编译，不执行产物；运行根 build/typecheck/
bundle，并对完整增量审读两遍。

目标 daemon 的真实 Status 输出及启动兼容性尚未验收。Status 不暴露 NRI 或独立的
镜像配置，也不证明宿主反向策略、独占 CSI actor、安装 provenance 或无间断 containment。
配置检查成功不形成资格 authority，不修改 source/7，不授权物理释放、读取已释放凭据
或开放后续周期复用。这些实现及各自验收仍是完整 K2 的独立前提。
