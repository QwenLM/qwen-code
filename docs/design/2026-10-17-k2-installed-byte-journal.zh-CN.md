# K2 安装字节日志关联

[English](2026-10-17-k2-installed-byte-journal.md) | [简体中文](2026-10-17-k2-installed-byte-journal.zh-CN.md)

## 状态与问题

这是基于 c4c065dca 的实现候选，普通数据验证进行中。实际 source 与 gateway 已通过 runtime identity/2 比较各自保留的安装字节，但 source/6 的持久 SOURCE_START 仍缺少这些观察，ARM 也未保存原持有 kubelet/registrar peer。Java 无法把记录中的安装与独立已审元数据比较。本增量接通这条数据链，不认证安装或授权释放。

## 生产者与格式

使用新的闭合 `qwen-k2-node-source/7` 格式，在 SOURCE_START 的 source identity 后追加实际 source/gateway 的 `qwen-k2-installed-byte-observation/1` 值，来自既有保留对象读端及认证原 gateway 身份，包含完整原 manifest 哈希及准确角色输入。不用调用者开关或复制的期待值冒充实际观察。

既有 ARM 就绪检查通过后，按原锁和进程复核，从已持有 frontend peers 取得两份不可变身份，ARM 准确保存 kubelet 与 registrar。发布 caller 必须等于 ARM 原 kubelet，之后卸载继续核对原发布 caller。同 ARM 重试返回原记录；peer 缺失、改变或丢失即拒绝，不新增替代 PID 查找。

明确维护 Go 字段顺序及 canonical body hash；仅 SOURCE_START 带安装观察，仅 ARM 带 frontend pair。保留长度帧、sequence/hash chain、依赖 cursor、准确原始 prefix 扩展及全部原出生/策略/停止检查。新读端拒绝 source/6 及更旧记录，不转换原字节、哈希或已存历史。旧 fixture 保持原字节，作为负向控制。

## 独立期待值与 Java 消费

已审 node deployment 输入增加必填 `installedArtifacts` 元数据目录，Node 持久保存必填 `installedBytes` 期待值；仅读取固定有界元数据名，不打开配置引用的 TLS/key 路径。将每份实际消费的原文件与 installation.json 核对，从已审 manifest、策略候选、编译记录、准确 source/shim 配置及 unit 元数据派生两角色期待观察。期待值来自操作员独立已审字节，不能从 observed stream 字段填入。

Node 配置持久保存必填 source/gateway 字节期待值及已审 kubelet/registrar 摘要。既有共用 validator 在 ARM/BIND/publication 保存及恢复读取时比较两份 SOURCE_START 观察、packed 长度/摘要及 ARM frontend 摘要；发布 caller 关联由日志状态机核对。既有 physical-source 验证自然复用此共用路径，不增加单独 authority 或成功 DTO。

保留既有64 KiB配置、1 MiB证据及192 KiB单记录预算，只保存紧凑哈希、路径和peer身份，不放packed策略、目录清单或TLS内容。缺少必填期待值的旧Node JSON拒绝，不补默认值。不新增SQL迁移或正向释放状态。

## 验证与验收

仅使用普通可移植字节/MapFS测试、明确选择的纯Java JSON测试，以及fixture不启动原生进程或网络服务的普通H2数据测试。保留合成fixture来源说明；验证Go/Java准确字段序、当前格式正向、旧版本拒绝、缺失/未知/变化字段及角色、原peer关联、独立期待值不匹配和完整行/prefix保持。Linux source/shim/assembler仅编译，不执行产物。既有受限native/source/custody/observer/Hosted/Main-F2/MySQL/进程故障及parser/image/ELF组不换路径执行。

本增量验收要求每个新字段均有真实生产者和消费者、独立已审期待值及闭合当前版本解码；实际native行为仍未验收。中英文设计及deployment输入同时更新，并完成定向检查及两次clean差异自审。

## 剩余工作

有效systemd/runtime配置、宿主actor/namespace及CSI独占安装事实和资格仍不完整。日志哈希不是外部信任根；最终四行原子释放、历史释放凭据及后续安全卷复用继续关闭，等待完整安装与生命周期权限。本增量不授予公开选择或释放能力。
