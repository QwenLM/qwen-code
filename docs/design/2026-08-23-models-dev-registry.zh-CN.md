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

显式模型配置仍优先于目录推断值。对于推断的上下文窗口，客户端维护的纠正优先于选中的目录；缺失字段回退到现有正则表和通用默认值。输出上限优先使用现有正则表，保留按 endpoint 维护的请求上限；目录只为表中没有匹配项的模型提供默认输出上限，不用这些目录值截断显式请求或环境变量预算。原有人工维护的输出上限和上下文窗口裁剪仍然生效。可信目录中的图片、音频和视频能力可以扩展正则默认值。PDF 会选择另一条依赖 endpoint 和协议的文件读取路径，因此仍需显式配置。显式配置的模态仍具有最高优先级。

仅当运行时缓存的 ISO `fetchedAt` 时间戳比内置快照新时，才以缓存替代内置快照。不完整响应会在替换完整快照或缓存之前被拒绝。新旧判断不使用文件系统修改时间。进程一旦选定目录便保持该版本，确保上下文窗口与输出默认值来自同一份数据。后台刷新把缓存写入磁盘，供下次启动的新进程使用。

即使缓存仍记录已退役的 1M beta 上限，Sonnet 4.5 的上下文也纠正为 200,000 tokens。Sonnet 4.6 与 Sonnet 5 保留目录中的上限。依据见 [Anthropic 上下文窗口文档](https://platform.claude.com/docs/en/build-with-claude/context-windows)。

preset 或显式配置的上下文窗口仍以该配置为准。自动检测使用目录，因此同一模型 id 可能与 preset 不同。保留这一优先级以提供已验证的元数据更新；endpoint 特有的覆盖使用现有模型设置。可信的模态补充也继续保留，因为它启用了 DashScope 上已验证的图片支持。按 provider 对齐留待后续，不把所有空的家族回退都解释为能力否决。

## 数据投影与 endpoint 歧义

默认目录的 token 上限和模态只来自受支持的一线 provider 白名单。`thinkingmachines` 是 issue #8558 中 Inkling 图片能力所需的显式模态例外，不采信其 endpoint 上限；转售商和路由商不能扩大其他厂商模型的能力。模型必须支持工具调用并输出文本。token 上限只接受正安全整数，输入模态只接受布尔值。

模型标识使用现有归一化规则。投影键必须是归一化不动点，且不能是纯数字标签、带 `@` 的别名、通用路由标签或其他有歧义的短键；读取旧版本缓存时也应用同一规则。归一化到同一个 key 的所有 token 上限必须一致，包括带日期和 provider 前缀的变体。只要存在分歧，就丢弃这些上限，保持现有正则或默认行为。裸模型名不能抹掉不同 endpoint 的冲突证据。这是保守策略：它不保证任意私有网关都适用，也不修正正则表已有的 endpoint 限制问题。

按 provider 查询需要修改模型解析契约及其调用方，留待后续，不用“第一个 provider 优先”近似实现。快照生成与运行时刷新使用同一套投影。

草稿中新增的 `model.customCatalog` 已移除：它的加载时机晚于首轮会话解析，进程全局状态还会在 Config 实例之间串用。私有或离线模型覆盖继续使用已有的 `modelProviders` generation 配置，不读取新增的自定义缓存文件。

## 存储与刷新

裁剪后的 JSON 快照随 CLI 发布，生成体积预算为 200 KiB；完整上游响应使用独立的 16 MiB 下载上限。后台刷新在代理初始化之后启动，超时为十秒，缓存间隔为 24 小时，通过 ETag 条件请求重新验证，在 `Storage.getGlobalQwenDir()` 下原子写入缓存。读取缓存与复用 ETag 均要求投影版本一致且存在可达的模型标识；旧版本或未标版本的缓存须完整下载并重新投影。调整投影规则时递增 `MODEL_CATALOG_PROJECTION_VERSION`。并发刷新共享进行中的请求。失败保留原有可用数据，仅记录 debug 日志。

`QWEN_CODE_MODELS_DEV=off` 恢复仅使用正则表。`QWEN_CODE_MODELS_DEV_REFRESH=off` 禁止刷新上游。`QWEN_CODE_MODELS_DEV_URL` 选择镜像，仍使用相同 provider 过滤。本次不引入请求时联网、跨进程锁、定时生成服务或新依赖。

## 验证与验收

定向测试覆盖缓存选择、非法条目、冲突拒绝、别名归一化、逐字段回退、纠正、刷新节流和失败处理。真实来源冒烟还需覆盖内置目录开关对照和真实 models.dev 刷新；mock fetch 无法证明上游数据准确。

[DashScope PDF 文档](https://www.alibabacloud.com/help/en/model-studio/pdf-understanding) 说明 qwen3.8-max 在北京和新加坡支持通过 Chat Completions 使用 `file_data` 与 `filename` 传入 PDF，并明确排除 Responses API 的 PDF 传递。因此目录不自动为任何模型启用 PDF；用户可针对已验证 endpoint 显式配置 `generationConfig.modalities.pdf`。这不会移除目录中的图片、音频和视频能力。自动推断 PDF 留待查询能识别 endpoint 和协议并完成真实识别测试后启用。

命令、结果和剩余交付门槛统一记录在[验证记录](../verification/models-dev-catalog/README.md)。最终 head 必须通过必要检查，PR 描述必须区分显式 PDF 配置与目录默认值。
