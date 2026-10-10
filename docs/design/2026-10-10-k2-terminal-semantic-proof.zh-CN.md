# K2 原始终态语义证明

[English](2026-10-10-k2-terminal-semantic-proof.md) | [简体中文](2026-10-10-k2-terminal-semantic-proof.zh-CN.md)

状态：纯 parser 前置增量已独立资格化；后续退役集成仍开放。
关联 #13395 / Draft PR #13526。

## 问题与范围

TypeScript authority 能生成 released activation 及其原始 boundary 资源。
Java 严格 native activation 解析器仅接受 active install/renew。
聚合退役流程需要先有独立事实解码器，可信 cut 消费者才能使用这些终态字节。

显式前序输入是可信本地 parser continuation：此前验证历史得到、且未修改的
genesis、activation、完整 Prefix 及同一链的 sequence/UUID/digest。公开 record
构造器和外部 JSON 不能证明该历史。调用期间调用者不得修改这些输入。
TerminalProof 独立深拷贝 Activation、完整嵌套 Prefix 和 boundary ref，
可变值的 accessor 返回副本。

只新增纯语义、不可变的 TerminalProof，与 active Activation 分离。
activation、advance、JDBC history、live append/replay、cold recovery 和
NativeHead 仍仅接受 active。当前没有事实型 JDBC 终态消费者，不新增无用的
historical 模式或 retry API。本前置增量不授予 writer、execution、cut、finalize、
DRAINED 或物理 RELEASED 权限。

## 严格原始前序与终态语法

要求显式传入已验证 genesis、active 前序和 settled Prefix，以及前序 sequence、
最后 record UUID 和 commit digest。原始 activation 限 writerGeneration1/epoch1；
replacement activation 历史不属于本原始 boundary 合约。要求 checkpoint 非空，
当前 input、attempt、stream 和 pending batch 均空。保留 checkpoint、batches、
fileHistory、intents 和 receipts；历史成员无需为空。

复用严格 transaction、envelope、reference 和 JSON helper。要求 releaseActivation、
命令 `<activationId>:released`、genesis definition digest、一个 activation event
和一个 commit marker、恰好下一 sequence、前序 parent/digest 链、同原始
writer/generation/epoch，以及空 latestCheckpointResourceId。event 使用既有七字段
和 released event ID。payload 恰好含九个 activation 基础字段：activation、epoch、
worker、subject 和上次 expiresAt 不变；phase released；leaseDurationMs/installRef
为空；boundaryRef 非空；无 renewalSeq。

五字段 ref 必须为 managed-activation-boundary/schema1，匹配引用字节、长度和 digest。
严格 UTF-8 JSON 上限16KiB；拒绝重复、尾随、未知或缺失字段。封闭 body 为
`{version:1,activationId,epoch,committedSequence,lastRecordUuid}`，末两字段精确对应
前序，不能用终态 event UUID。

TerminalProof 保留已验证前序 Activation 和 Prefix、boundary ref 与前序 pins、
终态 sequence 和最后 record UUID。历史 expiry 是 pin，不是新租约或当前时间判断。
保留 active renewal 兼容性：lease duration 改变仍可保留原 install ref；不新增
expiresAt/occurredAt/lease 精确算式。保留 active 解析器跳代 writer-generation
successor 支持。

## 权限与后续集成义务

producer 字节没有 retirement intent、owner barrier、完整 membership、Pod、profile、
authorization ceiling、immutable cut 和 worker finalization。语义有效不能补出这些事实。
采用新 resource/UUID/time 的语义相同 frame 不是 retirement 的 byte-exact retry。

真实 cut 消费者后续必须持有首次冻结的原始 boundary/request，验证完整 history、
membership delta 和最终 SQL head。必须返回独立终态结果并拒绝之后所有 appended row。
当前五个 JDBC history 消费者和两个 NativeHead 构造点均须在使用前序前拒绝终态。
空 intents 的 replay 也须拒绝。pre-cut retry 要求原始 live authority 和精确
intent/membership；post-cut retry 要求 immutable cut/sealed head，不能重新获取
writer。本前置增量不接入上述生产流程。

## 验证与验收

独立封存基线消费全部32个原始前序请求，并通过20项原 proof 测试。
原 release 的通用 frame 有效，但 active activation/advance 均以409拒绝，
保留 settled Prefix。独立基线报告保留 source/product/dependency pins、
原退出码和历史 SQL 证据的范围限制。

候选通过25项原 JUnit 测试及84条补充严格负例；其中81条先通过独立重签的
通用 frame，另3条单独确认属于 generic 结构拒绝。精确原 suffix、完整前序
相等、真实值双向 source/accessor 隔离、独立构造的12节点历史图隔离、
恰好16KiB正控和16KiB+1拒绝均通过。独立编译将全部83个 production source
绑定为150个 byte-exact class，两个 test class 也与封存产物精确一致。报告
SHA256：`83a447a5ee2b4cc195147dc56893eeae2635f88819ef092ebf2c214165130a7a`。

根 focused Broker/static/package/install 与 Node build/typecheck/bundle 通过。
使用实际安装新 Broker 的新39项 H2 MODE=MySQL gate 保留 active SQL release
拒绝及完整 rollback。独立 readback 封存该 root 补充，但不是独立 SQL 重跑、
真实 MySQL 或云验收。原失败测试准备日志保留。独立候选使用 Jackson2.20/
JUnit5.14；根 SQL gate 使用既有 Managed Agent Jackson2.21.4/JUnit5.12.2
组合。未启用终态消费者或新权限，配置 native review 仍无结论。

独立封存既有33-request producer text fixture 及原 sources/products。
重放 requests0–31；当前 active activation/advance 和 live SQL admission 必须拒绝
request32。保留原始退出码和 fixture 字节。候选纯解析器须接受精确原始 suffix，
保留整个 settled Prefix，并从前序 sequence41、UUID
`941bb2c6-c5a2-4571-8856-6e8820365fa9` 返回 sequence42、终态 UUID
`fc17e89d-c50c-4b55-b69d-aa58659e7242`。

语义负例须按需重建有效 transaction/ref digest，使拒绝证明语法而不是无关 checksum。
覆盖全部封闭字段、身份、前序 pin、settled-prefix 条件和资源上限。保留 active
install/renew/successor 控制及 live SQL release 拒绝和完整 rollback。
独立验证封存候选，执行 focused Java tests/static/package 检查和 build/typecheck，
完成两次完整 diff 干净自审。配置 native reviewer 无 verdict 期间保持 Draft/maintainer
评审开放。

## 剩余工作

本变更限 runtime-broker proof 及同目录测试。无 schema、endpoint、TypeScript producer
或 managed-store 集成变更。独立 publication 锁序先决增量已经独立资格化。
Generic retention、DRAINING settlement、selected-owner barrier、完整 inventory
cut、worker finalize、逻辑 DRAINED、合格原始物理来源、RELEASED/reuse 和
public enablement 仍待完成。
