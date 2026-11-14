# OpenTUI 引导创建 Agent

[English](2026-11-13-opentui-guided-agent-creation.md) | [简体中文](2026-11-13-opentui-guided-agent-creation.zh-CN.md)

## 问题与当前状态

此前手动阶段的原生创建器已支持手动创建和只读热冷详情，并有三种运行组合的聚焦公开用例通过记录。它有意只提供 Manual Creation，并使用手动步骤映射。Ink 还提供 Generate with Qwen Code：接收描述，调用已有 subagent generator，并在保存前供用户检查结果。OpenTUI 原先缺少这条生产路径。这项有限引导实现现已完成并通过源码 bundle 验证，不把手动结果转成引导创建或完整 Agent parity 验收。

## 预期行为

提供已有 Qwen 和手动选项，和 Ink 一样默认推荐 Qwen。使用已有 reducer 和按方式划分的六步、八步映射。引导描述使用原生行编辑器、粘贴处理、验证和 Ctrl+C 清空行为。明确提交时，用已有 helper 清理描述，并以实际 Config 和 AbortSignal 调用公开 leaf `subagentGenerator`。空输入不调用生成器。

同时最多一个生成请求。生成期间显示已有提示，禁止进一步描述提交与编辑。此时 Escape 中止该请求，回到可编辑描述并保留文本。后续 Escape 按普通返回或取消导航处理。当前请求成功时，只填充生成名称、描述和系统提示词，再进入工具、规范颜色和确认。用户通过当前 owner 守卫的 manager 路径明确保存前，不能存在 Agent 文件。有效请求的错误可见，描述保留；新请求必须由用户再次明确提交。

AbortController 引用与手动 ABA 修正引入的数字 owner-generation 计数器分开维护。每个请求捕获当时的 owner generation、发起 Config、步骤和方式。仅当对话框仍存活、owner generation 和 Config 仍匹配、待处理 controller 仍是同一个、signal 未中止，且仍位于预期引导步骤和方式时，其完成结果才有效。关闭、卸载或 Config 清理会中止并永久撤销该请求。A → B → 同一个 A 对象不能恢复其权限。取消以及过期的成功、catch、finally 后续处理，都不能推进表单、显示旧错误或清除更新请求的待处理状态。只有 controller 引用仍属于该请求时，才能清空它。

保留已验证的 save-generation 检查、待保存时锁定直到关闭的策略、冲突检查、明确确认、规范颜色和只读详情。生成请求不是磁盘提交，不转移保存所有权。不能用旧工作树只比较 Config 引用的守卫替换当前 epoch 修正。

## 已有合同与涉及文件

公开生成器接收描述、Config 和 AbortSignal，使用实际主模型，请求已有 schema 所要求的 `name`、`description`、`systemPrompt`，并返回验证后的内容。当前 `runSideQuery` 保留 signal、owner 的输出语言偏好和所选模型，然后调用 BaseLlmClient JSON 路径。该路径使用 `respond_in_schema` 和已有 provider、认证、重试行为。UI 不新增重试层、provider 选择或 Core API。保留当前 main 已抽取的输出语言 helper，不能从成熟工作树复制旧 Core 代码。

生产改动限制在 `SubagentCreateDialog.tsx`。扩展其同目录测试，并只把必要的 guided fixture 分支和完整聚焦用例加入已有交互测试。选择性复用成熟引导实现和测试，而非重放其完整补丁或替换手动 owner 修正。当前 reducer、生成器和假 HTTP 服务已提供所需合同，无需 manager 编辑、删除、外部编辑器或 Agent 执行改动。

## 验证与验收

先用实际全局安装的 Ink CLI 试跑公开引导计划，不升级它。这验证该分发版本上的测试计划，不代表最终候选。对冻结的仅手动原生候选，以实际画面记录缺少生成选项，保留存储不变证据，不假定后续阶段已到达。基线及后续所有 producer 都由 Root 持单 heavy 租约执行。

实现后，运行受影响 CLI 整文件测试、正常 build、typecheck、lint、格式检查和 bundle。单测覆盖空输入、Enter 批次、保存前明确检查、Escape 中止、晚成功和错误、新请求待处理时旧请求拒绝、卸载、包含 A → B → A 的 Config 替换、有效错误、明确重试和缺少 Config。保留已有手动八步测试和 save ABA 回归。单测必须断言可观察的 signal、表单、错误和保存权限，不证明原生传输中止或磁盘状态。

完整复用 `guided-creates-project-subagent-with-cancelled-generation` 公开用例，保留 120 秒用例和 12 秒观察限制。要求恰好两次 owned loopback 模型请求：首个请求被挂起、明确中止，传输在响应未完成时关闭；晚释放不能推进表单或改变任一 Agent 存储。第二个返回必需 schema 字段。要求保存前无文件，明确保存后得到精确规范蓝色 Markdown，用户 Agent 不变，热冷详情一致，两次零信号自然退出。finally 在清理临时目录前保存两个 Agent 存储的原始映射；若证据捕获也失败，应保留原行为错误。该用例有意要求 HTTP2，已有手动对照仍要求 HTTP0。

用一个新构建候选在 Node/Ink、Bun/Ink 和严格 Bun/OpenTUI 下运行引导及未改断言的完整手动对照。源码 bundle 通过不代表安装分发包或最终 merged-main 验收。保留全部先前失败及手动聚焦结果，单独报告新结果。

## 范围与后续工作

本增量只关闭引导创建接线和取消行为，不验证模型质量、真实外部 provider、用户级磁盘覆盖、manager 编辑和删除、外部编辑、Agent 执行与工具权限、其他平台、安装产物或完整迁移 parity。已有运行时版本、renderer 默认、时间预算和 Core trust 语义不变。当前没有阻止该提案的产品决策问题；基线观察可能要求在实现前纠正测试准备。Root 已在实现前完成两项基线。全局 Ink 到达两次生成请求及取消，然后因留存文件包含 `color: Blue` 而在精确 Markdown 断言失败；未升级该旧分发包。仅手动的原生基线到达实际方式页面，仅有 Manual Creation 且无模型请求，随后因缺少 Qwen 选项失败；其强制清理不是公开自然退出。两个原失败均保持原样。合并源码 bundle 已通过 build、typecheck、lint、格式检查、116 项受影响单测，以及六个完整公开用例：Node/Ink、Bun/Ink 和严格 Bun/OpenTUI 下各运行引导及手动创建。用例共完成十二次自然退出和六次 owned loopback 模型请求。这些结果只验证该本地源码 bundle，不代表安装产物或最终 merged main。
