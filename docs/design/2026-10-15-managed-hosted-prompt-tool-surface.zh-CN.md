# Managed Hosted 提示词的工具集合

[English](2026-10-15-managed-hosted-prompt-tool-surface.md) | [简体中文](2026-10-15-managed-hosted-prompt-tool-surface.zh-CN.md)

## 状态

本次修改已实现 Hosted 模型轮次的方案。验证结果记录在 E2E 报告中，不写入本设计。

## 问题与当前行为

Core 根据 `Config.getPromptToolSnapshot()` 生成工具使用指导和调用示例。快照为 undefined 时保留完整默认文本；空集合明确表示没有工具。若 `getPromptAgentReachable()` 表示延迟工具桥接可以访问 Agent，Core 也会保留 Agent 委派指导。

Hosted Harness 先使用本地注册表初始化 Core，然后移除本地工具，直接向 chat 安装 Session 的远程函数声明。这个过程改变了请求中的工具，却没有更新提示词快照。因此，只有五个工具的 Workspace Session 可能保留不可用的搜索或 Agent 指导；无工具 Session 也可能保留文件和 Shell 指导。

## 目标与范围

- 将每次新发起的 Hosted 模型请求的实际函数声明，用作 Core 现有工具指导与示例过滤器的依据。
- 支持空工具集合，以及模型轮次之间的工具增加和移除。
- 保留核心策略、Agent 指令、Workspace 上下文和调用方拥有的提示词文本。
- 保留用于恢复模型请求的原始已记录请求。

本次修改不扩展工具准入、不改变 Runtime 执行、不重写默认提示词中的每一处工具引用，也不过滤用户、Agent 定义或 Workspace 文件编写的指令。不新增公共 API、schema、配置项或提示词模板。

## 职责归属

Java 继续固定 Agent 定义版本并发布其指令。Runtime 和 Broker 继续提供 Workspace 上下文与已准入的工具操作。Hosted Harness 拥有 Session 的远程声明，负责将其名称同步到 Core 现有的提示词输入。Core 继续负责渲染提示词。

## 解决方案

在新发起的模型请求之前，只解析一次远程声明；无工具轮次使用空列表。将同一份列表安装到 chat，并将其中非空的工具名称整理为集合。把提示词工具快照设为该集合，包括空集合。只有实际声明 `agent` 时 Agent 才可达：Hosted 不向模型暴露本地注册表的延迟工具桥接。

声明名称集合变化或 Workspace 上下文变化时，在推理之前重建 system instruction。按成员关系比较集合，不依赖声明顺序；schema 和描述变化仍在每轮进入工具声明，无需为此重建提示词。上下文和工具集合同时变化时，只重建一次。沿用现有上下文组装，保持 Agent 指令位于项目上下文之前。

复用现有的 `setPromptToolSnapshot`、`setPromptAgentReachable` 和 `refreshSystemInstruction` 操作。同步逻辑放在 Hosted 模型循环内，不改变普通交互式与 headless 会话的注册表生命周期。

## 恢复与失败行为

已准备的模型请求包含原始 system instruction 和工具。重放时使用记录的请求，不用当前声明或上下文替换其中的提示词。重放进入下一次新发起的模型轮次后，再正常同步该轮。

解析声明和刷新提示词都必须在新请求开始前完成。任一步骤失败，都不应发送工具与提示词仅部分同步的推理请求。继续沿用已有的轮次失败处理。chat 内自动压缩保留当前 chat 配置；交互式手动 `/compress` 不属于本次 Hosted 轮次路径。

## 验证计划

先使用全局 `qwen` 尝试基线复现；Hosted 路由可用时，通过本地模拟 OpenAI 服务检查实际请求。若全局路由依赖不可用的 SQL/Broker 基础设施，则使用真实 Hosted Harness 模型集成边界。

覆盖无工具、五工具配置（`read_file`、`write_file`、`edit`、`run_shell_command`、`monitor`）、搜索/Agent 的增加与移除、名称不变仅顺序变化，以及记录的模型请求重放后进入新轮次。同时断言请求工具 schema 与生成的工具指导/示例，并验证核心策略以及 Agent 指令与 Workspace 上下文的顺序。

运行聚焦的 Hosted 模型测试与现有 Core 提示词测试，构建并打包 CLI，执行类型检查、变更文件格式与 lint 检查，并完成独立的修复后验证和代码审查。

## 验收标准

1. 新发起的 Hosted 请求，其工具 schema 与 Core 生成的工具指导/示例使用相同的声明名称集合。
2. 无工具请求使用明确的空快照；五工具配置在受过滤的段落中保留对应指导，移除不可用的搜索与 Agent 推荐。
3. 名称变化在下一次新请求之前更新指导；集合不变时，不因工具而重复刷新提示词。
4. Agent 指令与 Workspace 上下文保持内容和顺序。
5. 恢复请求保留已保存的提示词与工具；后续新请求使用当前工具集合。

## 风险与待定事项

主要风险是过于频繁地修改缓存提示词，或意外重新渲染已记录的恢复请求。通过名称集合比较和明确的重放覆盖控制这些风险。Core 现有过滤器有意只覆盖生成的工具指导和示例，不涵盖所有静态工具引用。本次修复没有待定的产品决策。
