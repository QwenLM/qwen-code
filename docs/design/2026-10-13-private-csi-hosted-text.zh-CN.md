# 私有 CSI Hosted 接入与原生文本 Turn

[English](2026-10-13-private-csi-hosted-text.md) | [简体中文](2026-10-13-private-csi-hosted-text.zh-CN.md)

## 状态与来源

这是从 #13526 拆出的可独立评审 feature。基线为 #13996 的私有 Session 与 SQL
权威，固定提交 `c0d930c066624988126e22aee2ee30417d45d391`。初始纯文本实现取自
`06a1a868568683211986aa6cfa665309fce0e2e9`，并对照提案当前提交
`0a88d72f824d47a7bfe6ec8c0861b7a6a67b3b95` 核对。历史测试报告不能资格化本次
拆分。原提案保持不变。

## 问题与范围

基线能创建原始私有 CSI Session 并验证原生日志提交，但没有为该 Session 调用
Hosted 的生产方。普通 Hosted create/load、writer seal 与 Runtime release
采用更宽的生命周期语义，不能持有这个私有 Session。

本拆分把预先创建的原 Session 接入一个经过认证的 Hosted boot，运行原生文本
Turn，保持 writer generation 1 与 activation epoch 1。不引入文件执行、替代
owner、冷恢复、退役、物理释放、公开 CSI 选择、Hook 或 MCP。不支持的路由继续关闭。

## 组件与 ownership

| 组件          | 改动与消费者                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启动          | 一次性读取 `QWEN_HOSTED_CSI_SESSION_STORE_URL`，验证经过认证的 loopback Hosted profile、原 Broker 配置与可信 Store origin。                                      |
| 私有路由      | `POST /session/:id/internal-csi/attach`、`POST .../text` 与 `GET .../history` 属于 live-session-owner 作用域；每次操作重查选定的原 Broker scope 与 HTTP writer。 |
| 原生文本      | 专用纯文本 adapter 组合既有 model runner、原生 Harness/controller、record sink 与 delta stream，不增加可配置的工具或恢复 adapter。                               |
| 本地停止      | HTTP Store 停止本地续租并等待已经进入的续租，不远端 seal。独立 app drain 与 host drain 都等待私有初始化、Turn 和 activation 续租。                               |
| Java operator | 既有私有 operator 增加有界 text 命令，解析原 SQL owner、协商 Hosted boot，再使用签发的 Session 凭据发送 attach/text。                                            |
| Broker 回读   | 复用基线私有 CSI acquire 响应中的持久化 canonical cwd 与 isolation class，无需修改 Broker 响应。                                                                 |

私有与普通 Session Map 互斥，包括 UUID 大小写别名。私有 UUID 在初始化首次
让出执行前保留。失败或结果不确定的初始化保持 blocked，不允许换新 owner
重试。未知、外来、draining、stopped 或 blocked 状态不回退到 primary Runtime。
路由认证不授权其他生命周期操作。

## 原生行为与失败

Store URL 只允许 HTTPS 或 loopback HTTP，禁止 URL 凭据、query 与 fragment。
原 Runtime 必须已经 READY；attachment 不 warm 或 release。准入固定 tenant、
workspace、Session、capability、binding generation、workspace generation、
isolation 与规范 Linux cwd。

配置 Store 的部署 base，例如 `http://127.0.0.1:8081`；HTTP adapter 自行追加
`/internal/managed-session-store/v1`。

Genesis 使用既有私有 definition 与 root snapshot。在 genesis 前要求 writer
generation 1，在暴露 owner 前要求 activation epoch 1。文本请求恰好含
`promptId` 和 `text`，使用规范 UUID，非空 UTF-8 文本最多 16 KiB。一个活跃
Turn 排除另一 prompt。相同 prompt 精确重试在当前准入后返回原 promise/result，
文本变化则冲突。原生未结算 input 阻止新 prompt。继承的私有 SQL grammar 不支持 Turn-budget directive，因此在原生 input 准入前拒绝这类请求。

模型不声明工具，使用 settled native history。原生 checkpoint、model attempt、
delta、完整 assistant Parts、usage 与 Turn settlement 仍是权威。沿用 SQL
grammar 支持 text 与 thought-text Parts，不支持的 signature/media 明确拒绝，
不静默删除字段。本拆分不扩宽该 grammar。普通已结算
模型失败允许后续 prompt；不确定的原生持久化阻止 owner。私有 close、activation
replacement 与 release 继续拒绝。

停止时中止本地模型，关闭准入和 timer，并等待已进入的初始化、Turn 与续租。
本地中止的 Turn 使用既有原生 `error` settlement grammar，不引入 cancellation outcome。不发送远端 writer seal、Runtime release 或删除。Java 请求在本地 30 秒预算
耗尽时取消 HTTP exchange，包括不完整响应 body；这不证明远端工作已停止。

继承的私有 SQL proof 最多接受 4096 个 history transaction，包括 activation 续租和模型 delta。以 20 秒续租间隔计算，空闲 attachment 约 22 小时就会触及上限，活跃 Turn 可能更早触及。耗尽后阻止 owner，不 seal 或 release。Compaction 与 owner recovery 留待后续拆分。

## 验证与验收

实现前记录全局 CLI 基线。验证拆分后打包 CLI 的认证私有路由、两轮原生文本、
完整 Parts/usage 与 history、精确重试、变化 prompt 冲突、ownership 别名、
畸形请求、错误凭据/boot/scope 与失败 sticky 状态。阻塞的续租必须延迟本地
停止，且没有远端 seal/release。运行受影响 Core/CLI/Java 测试、build、typecheck、
bundle 与定向静态检查，再完成两次干净的完整 diff 自审和独立评审。

没有真实 Kubernetes owner 时，使用隔离的确定性推理及明确的 Runtime/SQL
fixture，将这些 seam 与实际 SQL 集成分开报告。测试不资格化 Linux CSI、目标
集群部署、物理退役或安全复用。本跨包 feature 需要 maintainer 架构评审。

## 集成约束与后续

PR 叠在 #13996 上，使评审 diff 只包含本次拆分。依赖合入后从实际 main rebase
并复跑门禁。32 表新库提案 #14069 是独立 schema 改动，本次不复制其 SQL，也不
分配 migration。下一块拆分是有限原生 Read/Write/Edit 与完整结果消费链，然后
分别评审恢复和退役。本纯文本模块没有新的产品决策或公开 API 改动。
