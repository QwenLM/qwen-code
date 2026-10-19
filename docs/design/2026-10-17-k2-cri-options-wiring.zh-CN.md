# K2 CRI runtime options 接线

[English](2026-10-17-k2-cri-options-wiring.md) | [简体中文](2026-10-17-k2-cri-options-wiring.zh-CN.md)

状态：#13395 与 Draft PR #13526 的实现候选。

## 问题

此前生成的 handler 使用自定义 `io.containerd.qwen-k2.v1` runtime type。固定 upstream containerd v2.3.4 的 CRI 根据 runtime type 选择 options protobuf，与 `runtime_path` 无关。自定义 type 产生包含 TOML ConfigBody 的 generic `runtimeoptions.v1.Options`，但 K2 的 Info、bootstrap 和 Create 消费者要求准确的 runc Options protobuf。手写 runc protobuf fixture 和编译检查不能发现这个 producer 不匹配。

## 改动

保留 RuntimeClass 和 handler 名 `qwen-k2-runc-v1`，选择 builtin `io.containerd.runc.v2` runtime type，使 CRI 直接生成 runc Options；仍使用准确 `/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1` override 和全部固定 BinaryName/Root/SystemdCgroup 值。两个真实 container metadata 读端同步要求 builtin Runtime.Name。custom shim manager 的名字保留，它标识专用实现，不是 CRI options 格式。

固定 upstream 的 sandbox 和 worker 启动路径都将配置的 runtime path override 传给 task service，后者的 shim manager 解析该路径。这条静态调用链不是目标 daemon 启动验收。builtin name 本身不能证明执行了 custom shim；原持有 creator、真实 executable path/hash、受保护 shim 配置、任务边界、出生配对及准确 original/consumed 输入检查均保留。[实际配置检查](2026-10-17-k2-effective-runtime-config.zh-CN.md)通过原连接消费包含 path override 的选定生效配置；目标兼容性及完整安装资格仍需验收。

同步 renderer、两个 metadata 读端、既有期待值 fixture，以及完整两语出生/部署文档。不转换 generic options、不放宽 runc decoder、不改变创建契约或 source/7，不改写已保存 metadata/历史。generator/binary 身份改变后需要新工件及资格化，旧历史保持原始字节。

## 验证与限制

改实现前用普通惰性 options 数据对固定 upstream producer 复现不匹配；改后核对准确 handler 的 options 类型及固定值，并静态追踪两个 metadata 读端和启动 override。对实际 Linux source/shim/assembler 分别编译 amd64/arm64，不执行产物。运行根 build/typecheck 和 bundle，并对整个增量做两轮自审。

既有镜像 renderer 和 runtime 生命周期套件不换执行器重跑。普通 protobuf 数据检查不能证明目标厂商构建上的真实 CRI 启动、shim Info/bootstrap/Create 兼容性、已加载策略、安装信任、物理释放或安全卷复用。
