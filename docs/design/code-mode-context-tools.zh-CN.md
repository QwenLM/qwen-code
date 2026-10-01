# Code Mode 中的上下文工具

[English](code-mode-context-tools.md) | [简体中文](code-mode-context-tools.zh-CN.md)

更新：2026-10-01。已实现；验收证据保存在
`.qwen/e2e-tests/exec-skill-pr-2026-10-01/`。

## 工具暴露和输出

[Lazy Code Mode](lazy-code-mode.md) 定义当前可直接调用的工具。
其他已注册工具可通过 `exec` 调用，并遵循现有 agent 允许列表、参数校验、
权限、hooks 和取消规则。

嵌套工具结果保留为 JavaScript 值。脚本仅通过显式 `text`、`image`、
`audio` 和 `generatedImage` 调用输出内容。裸 return 值和成功结束没有输出。
自动 `toolResults` 包装已移除。原生 Omni 媒体和截图媒体保留现有传输方式。

## Skill 交付和恢复

在一次 exec 中调用 `text((await tools.skill({ skill: 'name' })).output)`，
读完指令后再在另一次 exec 中执行依赖操作。成功调用 skill 仍会应用运行时
副作用和模型选择。后续脚本错误保留模型选择，包括用显式 `undefined` 继承
配置模型的语义。

Exec 记录调用前已加载的 skill。新增 skill 只有在完整的当前正文出现在最终
输出中时才保留去重状态。遗漏、取消和截断会撤销新增加载，使后续显式调用
可以重试。已有 skill 和历史版本正文保持完整。内部 `newlyLoadedSkills`
元数据允许 scheduler 在最终聚合输出预算处理后再次检查，不增加模型文本。
通过 JSON 序列化的工具结果输出的完整正文也计入已交付内容。

显式脚本文本超过 32,000 字符响应上限时，先保存完整文件，再返回有界预览和
文件引用。文件包含本次截断前累计的脚本输出，包括脚本错误。模型可通过
现有 read-file 分页功能读取遗漏内容。QuickJS 独立的 100,000 字符累计上限
继续生效。

Resume 时，成对的 exec 响应通过 output 或 error 文本中的完整正文恢复去重，
正文必须匹配当前 skill 文件。旧 `toolResults` 会话继续可读。脚本可以自行
打印文本，因此 exec 历史仅恢复正文去重；直接 Skill 响应保持现有经过校验的
hooks 和权限恢复行为。截断或已编辑的正文无法恢复去重。

## Goal 屏障

Goal 更新等待先前嵌套调用完成，并阻塞后续调用。终止更新结束脚本并阻止
后续调用，保留已经产生的显式输出。非终止更新允许脚本继续执行。

## 验证和验收

构建、类型检查，并运行 skill、exec、scheduler、output 和 Code Mode 定向
测试。通过真实 CLI 进程和本地确定性 provider 验证遗漏后显式加载、resume、
skill 后脚本抛错、超长输出文件恢复和 Responses API resume。检查原始
provider 请求和持久化文件。另用真实模型观察它是否遵循显式输出说明，并
取回完整 skill 内容。

验收要求：显式短 skill 加载、重载和 resume 总共交付一份正文；遗漏或截断
后能成功重试；错误路径保留模型选择；遗漏字节可以恢复；普通工具显式输出
行为保持一致。脚本自行打印 skill 文本不能授予 hooks 或权限。
