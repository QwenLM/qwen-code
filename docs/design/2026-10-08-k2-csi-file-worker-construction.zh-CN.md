# K2-A2：私有 CSI 文件 Worker 的构建

[English](2026-10-08-k2-csi-file-worker-construction.md) | [简体中文](2026-10-08-k2-csi-file-worker-construction.zh-CN.md)

状态：2026-10-08 已实现构建组件，并通过独立本地验证。父提交基线为 `1b752436309beed109b6f47959d8bb3ec2994ca8`。属于 [Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526)、[原生文件执行](2026-10-07-k2-native-file-execution.zh-CN.md)及[完整 K2 交付](2026-10-06-kubernetes-k2-retirement-handoff.zh-CN.md)。

## 1. 问题与范围

保留文件后端与三工具 composer 已共享原始根目录描述符，但还没有生产 Worker 调用 composer。旧入口有意拒绝私有 manifest。父提交基线中的 CSI provisioner 生成 boot3 并保存仅支持 workspace 的 handle1；transport 调用旧 context 和物理 attestation 路由。删除这些拒绝会在原生文件准入完成前构建 provider、Hook、MCP 和 Shell。

本构建步骤为原始私有 provision request 提供独立 boot4/CSI2 生产与消费、不可变的保存 handle 及鉴权观察/context 路由。它不创建备份目录或工具。原始原生链路接通前，文件准入、prepare、Tool-v2 执行与结果保留仍不可用。这是必要的构建组件，不是 K2-A2 或整体 K2 完成。公开选择器、聚合 DRAINED/RELEASED、物理停止、NodeUnpublish 和安全卷交接保持门禁。

## 2. 闭合身份与信封

采用原生文件设计中的精确外层合同：boot4 与 ready4 有 `type`、`version`、`managedCsi`、`identity`、`context`，只有 boot 另有 `storage`。identity 正好有 `profile`、`sessionId`、`capabilityDigest`，重复 `csi-files-retirement/1`、不可变 CREATE request 的 canonical UUID isolation key 及已登记 manifest digest。内层 managed-context boot2 保持闭合，具有 session isolation 与同一 digest。固定 Runtime Session 与 Harness owner 均等于该 UUID；turn 与 prompt ID 保持独立。

物理 attestation 与 context attest/install/receipt 用 protocolVersion2、managed-csi/2 及同一 identity 包装不变的闭合内层合同，并使用 CSI-v2 路径前缀。版本号不授予能力变化。校验拒绝缺失/额外字段、跨 profile 或跨 Session 身份、重复 JSON key、非法 UTF-8 与尾随 JSON。响应不回显 boot token。

复用旧 storage、mount 与 Pod 校验作为数据校验，不拓宽 boot3 或 CSI1 wire。新 parser 可把已检查 shape 的 v2 信封投影给该校验器；旧端点不能接受新信封。保留初始 storage driver/ext4/NVMe 限制的明确说明：它们描述本验证 profile，不表示 runtime 架构强依赖阿里云。

## 3. 构建、路由与生命周期

隐藏 container bootfile reader 在旧解析之前选择 boot4。stdin 与 local-process 入口仍拒绝私有 digest。启动先校验完整 boot 并观察原始 mount，再监听。只注册 CSI-v2 精确路径上的 POST context-attest、context、物理 attest 和 drain。未知方法、query 别名以及旧 Tool/ACK/provider/publication/MCP/Hook 路由返回 404。不调用 generic context factory、Shell ledger、publisher registry 或三工具 composer。

context installation 校验原始 owner、`cwdRelative: "."`、精确私有配置 digest、workspace tuple 及原有 context digest/revision。验证借用同一原始 mount，只记录原 installation receipt，不做后端 metadata I/O。精确重复安装复用 receipt；owner/config/context 变化冲突。seal 或 close 后安装不可用。它不安装原生 activation，也不授予 bind/mutation 资格。

seal 固定原始 retirement ID 并禁止新 installation。status 要求同一 ID。drain 响应保持 DRAINING，并明确报告 file-admission-unavailable blocker；未完整接通的组合不能声称聚合 quiescence、DRAINED 或 RELEASED。attestation 为只读，可在 seal 后且 mount 仍可用时观察同一原始 mount。close 立即 fence 安装、关闭 listener 并 join 原 mount 生命周期。启动/listener 失败关闭该 owned 生命周期。不为提供零计数构建一个新 executor。

## 4. Java 生产链与保存身份

只从不可变的精确私有 request 选择 CSI2：provisioner kind、managed-context storage、session isolation、canonical UUID key 与已登记 digest。其他 workspace request 保持原 CSI1 producer 与 handle1。不支持的 session profile 仍拒绝。

私有保存 handle 使用 version2，包含现有精确保存字段及 `profileIdentity`。原保存字段 `identity` 仍是 unsigned saved object 的 digest，不解释成新的三字段身份。boot digest 包含 boot4 identity。对照 request 与 seed 校验 profileIdentity、两个原始 attestation 信封、Pod/Secret UID、固定 image、spec digest、storage reservation 和原 mount。resume 重新生成并精确比较原 Secret，不创建新 boot 或 mount。handle version/profile 不匹配拒绝 adoption。

HttpRuntimeTransport 从同一私有 request 选择两个 CSI-v2 attest 路径，并验证回显 identity；仅为匹配的原 Session 与精确私有 context 配置选择 CSI-v2 installation wrapper。保留既有 lease 校验、禁止 redirect 与 body 上限，并要求三个私有请求的 response header 均包含原 incarnation。Legacy response 规则不变。不调用旧 activation，也不授权工具。后续实现闭合完整链路前，现有 private acquisition/native admission 门禁仍生效。

## 5. 下一步保留的集成要求

只有原始 SQL/native READY 准入与固定 context installation 完成后，bind 才能创建保留 Session 目录。在第一次 await 前登记唯一 compose promise，并将其精确 history 实例交给实际 Write/Edit、观察与 close。不要使用会创建第二个 history 的旧 raw bind。

下一步原生 history 集成必须先发布原 input/definition 并 reserve 全部已接受的 SQL PREPARED execution，再提交持久 intent；之后在原 connection 上验证 intent、prepare preimage、提交 prepared 并 dispatch。checkpoint 携带全局 tool ordinal 与继承的 batch ID；tool.intent 携带当前 assistant-message batch 与局部 ordinal。不要强制两者的 ID/ordinal 相同。通过原 assistant/function/part 身份与前一个 checkpoint 推导精确成员关系，保留此前 items。

Broker→worker history wire 必须在打开任何 backup 或 mutation 路径前完成定义及验证。producer 从原始 authority 推导当前原资源、路径与 SQL 成员；caller paths、持有 bearer、局部 prepared Set 或提供一个 ref 都不足以构成资格。本构建步骤不添加猜测的 grant protocol 或第二 journal。后续 body2 迁移、真实结果消费及 until-finalize 保留仍以完整原生文件设计为准。

## 6. 验证与验收

双语言使用相同闭合 fixtures 与真实 Java HTTP producer 验证。检查生产 worker bootfile 选择新分支、原有启动兼容，以及私有 stdin/local/boot3 仍拒绝。证明 startup/context/attestation 不产生 history prefix，不构建 generic 或 file tools。检查真实 HTTP 路由、identity mismatch、mount startup 失败、seal/install 竞争与 owned 资源的重复 close。

mock Linux mount observation 只证明接线 fixture。必须验证真实 Darwin refusal。实际 Linux CSI、Kubernetes API reservation/Secret/Pod identity 与 MySQL native admission 仍需后续完整链路证据；parser 成功与 informational ready 均不能替代。独立全局 qwen dry-run 先记录实际能力缺口，再验证 local build。完成 build、typecheck、适用 bundle 和 focused tests，再自审并执行仓库 review 流程。保持 Draft 与 maintainer review 边界。

独立本地验证通过 38 项选定测试与 10 个唯一实际 built-startup/HTTP 组。真实 Darwin boot4 到达 mount refusal 且不输出 ready；受控 mount/listener fixture 覆盖接线及 seal/install/close 顺序。独立执行已编译 Java 测试，覆盖实际私有 CREATE producer、H2 持久化/reload 和 loopback transport；Kubernetes API 与 mount observation 仍是 double。HTTP 依赖预锚补充重复同一 10 组，不计为额外唯一覆盖。自有资源已清理，声明输入窗口零漂移。这些结果只验证本构建组件；原生 review 未完成，真实 Linux CSI/MySQL/完整 K2 验收仍须完成。

## 7. 受影响 consumer 与剩余问题

生产 consumer 为 CLI container reader/startup/ready 生命周期、独立 CSI-file envelope/route owner、Java CSI envelope producer、HTTP attest/install transport、CSI provisioner 及 saved identity reader。每处实际读取新 version/identity，不添加无人使用的 optional 能力开关。旧 schema 与路由保持独立。

本组件未解决剩余 history-grant trust boundary，在启用 bind/prepare 前必须完成。物理 writer/helper 停止、sealed backup/orphan inventory、原 cut/finalize 与原子 release 仍属于整体 K2。本设计不延期或删除这些要求。
