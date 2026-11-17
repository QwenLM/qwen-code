# Shell 路径与进程作用域

[English](2026-11-17-shell-path-ownership.md) | [简体中文](2026-11-17-shell-path-ownership.zh-CN.md)

状态：已在本地实现，打包 CLI 验证待完成。

## 失效边界

AUTO 模式下，无法解析的路径必须由人决定，即使权限规则本身要求询问，或 `PermissionRequest` hook 返回 `allow`。只有 `safety_check` 而没有人工决定标记的 fallback，会让调度器将该 hook 响应当成批准。

路径提取还需要区分一个词解码后的文本与它在 shell 中的角色。仅含变量的 `find` 起点不是省略起点；带引号的 `time` 不是保留字；子进程切换目录不会移动父进程；移除 wrapper 引号也不能撤销外层 shell 已完成的展开。

## 共享分析

词法分段仍由 `splitCompoundCommandSegments` 负责。默认模式保留命令规则的分段行为；路径 walker 请求分组分隔符和空结构片段，扩展 glob 的括号则保留在原词中。

前台命令与 brace group 使用可变 cwd 状态，subshell、后台列表和管道元素使用独立状态。某些 shell 行为，包括 Bash `lastpipe`，可能让管道最后一个元素影响父进程，因此最后一段切换目录后，后续 cwd 记为不确定。分组重定向在正文切换目录之前解析。分组嵌套达到 100 层时，不再递归，而是保留文件操作并将其路径标为不确定。

`find` 保留表达式之前的每一个起点词及展开标记，也识别前置的 `-H`、`-L`、`-P`。tokenizer 为保留字识别保留空引号信息，`ti''me` 不会变成 `time` 前缀。

wrapper 移除引号后返回解码的脚本文本，不再保留可能隐藏全部操作符的外层引号。可选的 `expandedWords` 收集器记录外层展开的拼写。同步 walker 通过 `try/finally` 限定这些标记的作用域，路径层在规范化之前检查它们，避免内部引号或解码产生的反斜杠隐藏展开。同一展开拼写在不同位置出现时，匹配采取保守策略；字面美元符或不同变量名不会自动成为展开。

存在外层展开时，Monitor 同时保留规范化安全视图与原始 wrapper；带展开的替代 payload 也保留 wrapper。这些只是分析输入，不是额外启动的命令，`spawnCommand` 不变。

## 审批契约

无法解析路径的地板也覆盖 cwd 未知的相对路径操作，先于通用 ask-rule fallback 执行，并设置 `requiresHumanDecision: true` 与人工审批提示。已有调度器和 ACP 消费者读取这两个字段，阻止 hook 自动批准并隐藏持久放行选项。不新增审批策略，也不允许 hook 绕过。

## 验证与限制

按 [E2E 方案](../../.qwen/e2e-tests/shell-path-ownership.md) 验证。源码回归覆盖权限管理器、AUTO evaluator、调度器 hook 路径，以及解析器和工具函数控制项。真实 Bash 探针使用独立工作区和 HOME，不接触操作者的配置或 shell 启动文件。

提取器仍是尽力而为的 shell 分析，不是完整 shell 解释器。字面路径精度、已知 deny 规则、ANSI-C 字节、默认命令规则分段和预算回退都需要持续回归。源码测试和原生 shell 探针不等于打包 CLI 或 ACP 端到端覆盖，后两者必须独立报告。
