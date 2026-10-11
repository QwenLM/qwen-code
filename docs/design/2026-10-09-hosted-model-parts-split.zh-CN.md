# Hosted 无工具模型 Parts 保留

[English](2026-10-09-hosted-model-parts-split.md) | [简体中文](2026-10-09-hosted-model-parts-split.zh-CN.md)

## 范围与来源

从 Draft PR #13526 的 `e8f11063463f846ab807764ede8e9aad272204f2`
拆出已完成的 Hosted 模型边界修复，基于 main `f829ee98c74`。
包括原提交 `4f82b9d597bd` 的无工具 Parts 保留，以及源 head 中只有思考内容
的历史过滤规则。沿用已有 Hosted 工具接口，无需引入后续 CSI turn 抽象。

本部分可独立评审，改变普通 Hosted 无工具轮次。私有 CSI 接线、授权、文件执行、
SQL 迁移、冷恢复与物理退休仍保留在原 Draft 中。

## 行为与消费方

当前无工具调用方仅返回累积的显示文本和模型名称，assistant 消费方据此重建
一个文本 Part，丢失其他 provider Parts。改为返回最终模型历史的完整深拷贝，
保留顺序、思考内容、thought signature 和 inline data；显示文本仍单独返回。
缺少最终 model 历史时报告错误，与已有工具轮次的行为一致。

`hosted-harness-session.ts` 中普通轮次和恢复轮次的 assistant 消费方均已优先
使用 `result.parts`，缺失时才回退到文本。无需给消费方或公开接口增加字段、
开关或路由。后续模型轮次通过已有历史路径复用保存的 Parts。

`MessageDisplay` 抑制输出时，两种分支都返回空文本和空 Parts。Retry、fallback
和 Stop 处理仍决定最终接受的模型历史。Hook 生成的停止原因继续使用明确的文本 Part。

只有思考内容的历史 assistant 没有回答用户问题，其问答对应从无工具历史中省略，
与空 assistant 或缺失 assistant 一致。包含可见文本回答的问答对保留完整 Parts。
已有工具轮次的历史及 function-call 身份检查不变。

## 验证

比较原 main 基线和拆分后的候选版本。检查完整有序 Parts 与深拷贝、历史缺失、
有工具和无工具两种输出抑制、retry/fallback 输出，以及只有思考内容与包含可见
回答的历史。运行 Hosted 模型、真实本地 provider 集成和 Session 消费方测试，
以及全仓 build 和 typecheck。使用自有 loopback SSE provider 观察返回 Parts
和下一次请求，无需外部模型。独立复现和验证写入 PR 的单独报告；#13526 的旧证据
不能证明本次拆分版本。

## 风险与后续评审部分

普通 Hosted 无工具 transcript 从仅保留显示文本改为保留全部 provider Parts。
已有资源大小限制与 provider 历史转换规则仍适用。这不证明私有 CSI producer 或
worker 已通过验收。

本部分合并后，先将原 Draft 同步到 main，再拆下一部分。候选边界为完整 retained
文件读取与历史、原始 CSI 身份与准入、native 批次和历史执行。具体范围须基于
刷新后的 main 检查依赖；冷恢复和物理退休仍是独立验收门禁。
