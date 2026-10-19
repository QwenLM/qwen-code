# K2 物理退役协调与保留进度

[English](2026-10-20-k2-physical-retirement-progress.md) | [简体中文](2026-10-20-k2-physical-retirement-progress.zh-CN.md)

## 问题与当前状态

第二块（#14698）实现原 owner 的应用 DRAINED。第三块（#14758）提供严格节点来源证据和受控创建，但明确拒绝带 source 关联的应用退役。第四块提供安装与冷启动软件。第五块从累计 #13526 提取持久物理协调，不声称原生安装或安全卷复用。

## 范围与依赖

基于第三块提交 `1656cf02fd8419ce7baf608adcfb21a2d28a3dfc`，保留其严格安装物、出生和 journal reader。第四块的生成器、打包和 cold-init 不纳入本 PR。只支持正常结算的原 generation-1/epoch-1 owner。来源证据、安装资格和最终物理释放分别验证。

增加持久 plan、stop intent、原 UID/resourceVersion 限定的正常 Pod 删除、有界 reply 保存、source-prefix 观察及保留状态/重试。阶段止于 PLANNED、INTENT、STOPPED、UNPUBLISHED。不释放 binding、slot 或 physical holder；不包含 RELEASED、公开 selector、释放历史支持和后续周期复用。

## 应用证据兼容

保留全部已发布迁移和现有 inventory/2 字节。带 source 关联的退役使用单独版本的 inventory，固定完整 typed 原 source 行；旧 owner 继续使用 inventory/2。将原 PUBLISHED source 与 reservation、registration、保存的 worker handle 核对，拒绝缺失、不完整或变更的证据。不支持的 source-owner 历史读取继续关闭。只有原 application store 能在物理操作同一事务 Connection 上构造验证后的 DRAINED 结果。

## 协调与持久化

在第三块之后追加 physical-progress companion 迁移。该表位于 application snapshot 之外，进度更新不会破坏不可变 application baseline。验证完整 schema，在 application DRAINED 前拒绝意外行。固定精确 plan 字节及 hash、原 source incarnation、publication prefix、Pod 身份和 protection。外部 RPC 在 SQL locks 外；每次持久写入都重新取得并核对原 ownership。

发送前保存不可变 deletion attempt。使用保存的准确字节发送，限定 UID 和 resourceVersion，gracePeriodSeconds=30、Background propagation。保留未知结果、实际有界 status/body、准确重试身份和单调计数。HTTP 接受、404 或 Pod 缺失都不证明物理停止或卸载。仅连续原 source 证据能推进观察；UNPUBLISHED 不授予释放权限。

每个 resourceVersion 最多尝试一次，重启后也不重发。持久化后、发送前崩溃或 preflight 失败，会使该 attempt 保持未知；只有观察到不同 resourceVersion 才能追加下一次尝试，最多八次。status 要求已有保存的 plan，未规划的 owner 会被拒绝。

私有 status 和 plan 只检查 SQL，不加载网络凭据。网络动作佐证固定 node UID/boot/Ready 和受保护 volume。foreign owner、变更 plan、gap、替换 source、事务误用和非法证据均失败关闭。

## 涉及组件

Java application inventory/store、physical coordinator/store/progress/source/私有入口、精确 Kubernetes deletion client 和测试，以及仅追加的 managed-schema 元数据。不计划改变 TypeScript 行为、公开 HTTP route 或原生宿主安装。

## 验证与验收

先运行全局 qwen 基线，并说明私有 Java 命令为何需要组件测试。验证原 application DRAINED 到 physical plan/status/restart、准确 deletion 重试和未知结果、source-prefix stop/unpublish，以及不变的 DRAINING ownership。验证旧 snapshot 字节、旧保留读取、错误 source/UID/plan、非法 companion schema、foreign transaction 和拒绝全回滚。运行受影响 Java 测试、包含静态门的完整 Java verify，以及自有 MySQL 8.4；共享协议运行 build/typecheck。结果绑定本候选并披露夹具。原生 Linux/CSI、安装 confinement、实际冷启动、release 和 reuse 单独验收。

## 风险与待定问题

本 PR 堆叠在[第三块](https://github.com/QwenLM/qwen-code/pull/14758)上，可与第四块并行开发和评审。第三块合并后再合并本 PR，并 rebase 到 main；迁移编号按实际落地顺序分配。source-associated inventory 是新格式，不得重新解释或改写 inventory/2。真实节点资格与 release authority 仍未完成，协议夹具和 artifact hash 不能授予它们。
