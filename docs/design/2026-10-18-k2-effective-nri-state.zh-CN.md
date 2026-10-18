# K2 原 runtime 的有效 NRI 状态

[English](2026-10-18-k2-effective-nri-state.md) | [简体中文](2026-10-18-k2-effective-nri-state.zh-CN.md)

## 状态与问题

完整宿主策略工件集之后的实现候选。此前基线的 gateway 已检查部分有效 CRI 设置及原
overlay plugin root；这些回复和磁盘 `disable=true` 都不能证明实际原 runtime
中的 NRI instance 已禁用。stock containerd 2.3.4 在两种状态均可无错误地初始化
NRI instance，且既有 introspection metadata/extra 接口没有导出该状态。默认启用
NRI，现有 runtime fragment 未覆盖该设置。

## 原 daemon 生产端

增加专用 Linux containerd 入口，复用固定上游的 `command.App()` 及正常按
OS/build tags 选择的 builtins。只注册一个固定 observer，专用 type 为
`io.qwen.k2.nri-state.v1`、ID 为 `state`，依赖 `NRIApiPlugin`。
不能使用 `InternalPlugin`：上游 NRI 已依赖 internal plugins，反向依赖会形成环。

observer 经 `GetByID` 取得准确 `NRIApiPlugin` ID `nri`，与 CRI service 的实际
选择一致。要求期待的唯一可用 instance 及窄 `IsEnabled() bool` 接口。持有该真实
对象，每次请求都调用它；不能复制操作员期待值或缓存初始 boolean。不提供
observer 配置开关。只在专用 daemon 入口注册，不给 client 引入 init 副作用。

使用既有 introspection `PluginInfo` 扩展，必填标准 protobuf Empty options，
返回 BoolValue extra。双方使用固定 `typeurl` helper，准确类型名为
`google.protobuf.Empty` 和 `google.protobuf.BoolValue`。缺失/错误 options、
类型及 unknown fields 均拒绝。false 的 protobuf 正文合法为零字节，必须先核
extra 对象存在及其类型，再解码值。生产端只观察，不启动或停止 NRI、不改配置、
不执行插件、不创建另一 socket。

该观察属于原 daemon instance 的 process-global 状态，只由 gateway 持有的
原 runtime 连接消费，不允许调用方选择 Workspace，也不增加公开 route。

## 必填 gateway 消费端

在既有 `cristate.Guard.Verify` 的 Status/overlay 检查之后查询固定 observer，
共用同一五秒期限与 32 KiB plugin 回复上限。核对固定 plugin 身份、初始化成功、
准确 extra 类型及闭合值，要求 NRI 已禁用。缺失、不支持、启用、变化、格式错误、
超限或丢失回复都永久使 guard 失效。保持实际启动与既有两侧 control 边界调用
接通，不增加可选开关或 fallback。

原 executable 已由受保护 runtime target 及两角色配置的 runtime digest 固定。
操作员必须构建、审查并固定新的专用 daemon 工件，stock daemon 无法满足本契约。
来源是模块选定上游源码/checksums 与最终 executable hash，不能靠版本字符串。
构建不使用 `no_cri`；`CGO_ENABLED=0` 会排除条件 btrfs 支持，不能称为包含全部
可能 builtin。模块 lockfile 必须覆盖实际新增 command、CRI/CNI、NRI 及默认
WASM 依赖闭包。

在既有 runtime fragment 的固定 `io.containerd.nri.v1.nri` table 中显式加入
`disable=true`，作为原 daemon 的预期配置；强制 observer 仍核对实际 instance。
禁用 plugin registration 本身不能满足这项观察。

## 文件与验证

增加 Linux daemon command、小型 observer 包及其显式 registration/wire
helper。更新既有 guard/测试、runtime fragment 及其测试、Go module pins、
双语部署说明及本设计。
不改变 source/7、安装图、Java 契约或 SQL 格式。

先用实际上游 warning/NRI registration、独立 concrete 配置及官方 config
decoder 的 `disable=true`/`false` 复现 stock 缺口。可移植测试不得调用 Start
或 NewCRIService。enabled 构造会改变 timeout globals，测试必须串行，且不修改
registration 默认值。

实现后，将这些真实 instance 经实际 observer、上游 introspection service
及内存 gRPC transport 接入真实 gateway guard。CRI Status 与 overlay 数据可
明确作为夹具；NRI 值必须来自实际上游 initializer。覆盖两状态、缺失/歧义/失败
instance、准确 options/type/unknown-field、false 空正文、预算、期限与原 client
连续性，以及永久失效。保留全局 CLI 检查，对私有阶段使用直接 probe 回退，保留
baseline 及全部失败。运行可移植包测试、Linux 双架构构建、适用 root 检查，进行
两轮完整 diff 自审并取得独立审查。

## 验收与剩余工作

软件验收要求真实 producer→wire→guard 链及既有生产调用者接通，对 stock 或
不可用观察拒绝。它不资格化 native daemon、全部线程隔离或采样之间的连续区间。
新的原节点仍需真实已审 daemon/configuration 字节、从出生起 NRI 禁用、完整宿主
策略和标签进入、policy lock、actor/admission 排除、CSI 独占及正常生命周期事实。
这项 RPC 不能排除宿主内存被篡改。

最终绑定原 Connection 的物理 authority、四行原子 writer、RELEASED 历史读取及
安全后续周期复用仍未完成且保持门禁。本软件增量不创建云容量、不改节点配置、
不重启 daemon、不加载策略。软件协议没有待定选项；接收实现前仍需测量准确的
依赖增长及可移植 constructor 行为。
