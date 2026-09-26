---
title: '数据驱动的模型元数据目录（models.dev）'
date: '2026-08-23'
status: '已在 PR #11959 实现'
---

# 数据驱动的模型元数据目录

[English](2026-08-23-models-dev-registry.md) | [简体中文](2026-08-23-models-dev-registry.zh-CN.md)

## 问题与范围

目前更新模型上下文窗口、输出上限和输入模态需要修改硬编码表并发布 CLI。PR #11959 加入内置 models.dev 快照和后台刷新。本文吸收之前纯设计 PR #9851 中有用的约束，将实现及其验证统一到一个 PR。

本次不涉及 reasoning-effort 档位、推理协议字段、价格、provider 检测和 OAuth 模型列表。原方案中的 effort 元数据迁移留待后续；实现前需要重新验证其中与 provider 相关的事实。

## 解析与优先级

显式模型配置仍优先于目录推断值。对于推断值，客户端维护的纠正优先于选中的目录；缺失字段回退到现有正则表和通用默认值。模态取目录与正则能力的并集，保留现有支持。显式配置的模态仍具有最高优先级。

仅当运行时缓存的 ISO `fetchedAt` 时间戳比内置快照新时，才以缓存替代内置快照。新旧判断不使用文件系统修改时间。刷新缓存不会重写已经解析的会话配置；后续解析可看到刷新后的数据。

即使缓存仍记录已退役的 1M beta 上限，Sonnet 4.5 的上下文也纠正为 200,000 tokens。Sonnet 4.6 与 Sonnet 5 保留目录中的上限。依据见 [Anthropic 上下文窗口文档](https://platform.claude.com/docs/en/build-with-claude/context-windows)。

## 数据投影与 endpoint 歧义

默认目录只读取受支持的一线 provider 白名单。模型必须支持工具调用并输出文本。token 上限只接受正安全整数，输入模态只接受布尔值。

模型标识使用现有归一化规则。归一化到同一个 key 的所有条目必须一致，包括带日期和 provider 前缀的变体。只要存在分歧，就丢弃整个 key，保持现有正则或默认行为。裸模型名不能抹掉不同 endpoint 的冲突证据。这是保守策略：它不保证任意私有网关都适用，也不修正正则表已有的 endpoint 限制问题。

按 provider 查询需要修改模型解析契约及其调用方，留待后续，不用“第一个 provider 优先”近似实现。快照生成与运行时刷新使用同一套投影。

草稿中新增的 `model.customCatalog` 已移除：它的加载时机晚于首轮会话解析，进程全局状态还会在 Config 实例之间串用。私有或离线模型覆盖继续使用已有的 `modelProviders` generation 配置，不读取新增的自定义缓存文件。

## 存储与刷新

裁剪后的 JSON 快照随 CLI 发布，生成体积预算为 200 KiB。后台刷新在代理初始化之后启动，超时为十秒，缓存间隔为 24 小时，通过 ETag 条件请求重新验证，在 `Storage.getGlobalQwenDir()` 下原子写入缓存。并发刷新共享进行中的请求。失败保留原有可用数据，仅记录 debug 日志。

`QWEN_CODE_MODELS_DEV=off` 恢复仅使用正则表。`QWEN_CODE_MODELS_DEV_REFRESH=off` 禁止刷新上游。`QWEN_CODE_MODELS_DEV_URL` 选择镜像，仍使用相同 provider 过滤。本次不引入请求时联网、跨进程锁、定时生成服务或新依赖。

## 验证与验收

定向测试覆盖缓存选择、非法条目、冲突拒绝、别名归一化、逐字段回退、纠正、刷新节流和失败处理。真实来源冒烟还需覆盖内置目录开关对照和真实 models.dev 刷新；mock fetch 无法证明上游数据准确。

[DashScope PDF 文档](https://www.alibabacloud.com/help/en/model-studio/pdf-understanding) 说明 qwen3.8-max 在北京和新加坡支持通过 Chat Completions 使用 `file_data` 与 `filename` 传入 PDF，并明确排除 Responses API 的 PDF 传递。因此目录不自动启用 qwen3.8-max 的 PDF。查询纠正同时覆盖内置和刷新的数据；用户可针对已验证 endpoint 显式配置 `generationConfig.modalities.pdf`。图片、视频能力和其他模型保持不变。自动推断 PDF 留待查询能识别 endpoint 和协议并完成真实识别测试后启用。

命令、结果和剩余交付门槛统一记录在[验证记录](../verification/models-dev-catalog/README.md)。最终 head 必须通过必要检查，PR 描述必须区分显式 PDF 配置与目录默认值。
