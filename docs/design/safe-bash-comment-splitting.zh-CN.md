# 权限规则中的保守 Bash 注释识别

[English](safe-bash-comment-splitting.md) | [简体中文](safe-bash-comment-splitting.zh-CN.md)

## 状态

由 #11821 的聚焦替代方案实现。

## 问题

`PermissionManager` 在应用 `Bash(...)` 规则前会切分 shell 命令。对于 `echo 'a' # comment ; rm -rf /tmp/x`，与 shell 无关的切分器会把 Bash 注释内的分号当成真实边界，导致已经允许的 `echo` 仍对 Bash 根本不会执行的命令弹出确认。

全局应用 Bash 注释规则并不安全，因为 Qwen Code 也可能通过 `cmd.exe` 或 PowerShell 执行命令；把切分器继续扩展到 heredoc 或嵌套 substitution，则会在权限边界重新制造一个不完整的 shell parser。

## 目标

- 为确认通过 Bash 执行的简单单行命令修复 #11815。
- 对非 Bash shell 和不支持的语法保持现有的保守切分。
- 让 `PermissionManager` 内部每一条 `run_shell_command` 的 Bash-rule 路径使用同一个切分决策。

## 非目标

- 完整解析 Bash 注释或 heredoc。
- 修改虚拟 shell operation 提取或 cwd 跟踪。
- 把该快速路径应用到 `monitor`。那里被分析的命令是 `normalizeMonitorCommand()` 去引号后的 `safetyCommand`，而不是 monitor 实际 spawn 的文本，因此其中的 `#` 不一定是注释，按注释折叠可能吞掉 spawned 命令真正会执行的分隔符。monitor 继续使用现有切分器，并由此继续被 `Bash(...)` 规则覆盖。
- 收敛自定义命令以及 `ShellTool.getConfirmationDetails` 使用的另一套旧切分器（确认对话框列出的子命令，以及它的「始终允许」按钮建议的规则）；该工作由 #11882 负责。推迟这项收敛并不等于这两个消费者不受影响：两者都会调用 `PermissionManager.evaluate` / `isCommandAllowed`，而后者硬编码了 `run_shell_command`，因此它们都会进入新的注释感知切分，只是各自的子命令列表仍来自旧切分器。对自定义命令而言这改变了结果——`shellProcessor` 对同一个字符串做两重把关，其中全文的 `isAllowedBySettings` 检查现在可能返回 `allow` 而不是原先的 `ask`，于是在 merge base 上会弹确认的注入命令可以跳过确认。这个行为本身说得通（Bash 只执行注释前的文本，且 `ShellExecutionService` 通过与快速路径相同的 `getShellConfiguration()` 来 spawn），但它确实是一处真实发生的确认行为变化，并且同一个函数现在对同一字符串混用两套切分。

## 设计

`PermissionManager` 从 `getShellConfiguration()` 读取当前 `ShellType`。它的四个 `run_shell_command` Bash-rule 路径统一调用现有切分器外的一层 shell-aware 包装。

只有同时满足以下条件时，该包装才把原命令保留为一个 segment：

- 工具是 `run_shell_command`，即被扫描的字符串正是 shell 将执行的文本；
- 当前 shell 是 `bash`；
- 命令只有一个物理行；
- 引号外的 `#` 位于空格或制表符之后，且其前面存在非空白代码——若 `#` 之前只有空白，整个 segment 就是一条注释，无法再匹配任何 `Bash(...)` 规则，折叠它会静默丢掉用户显式配置的规则；
- `#` 之前的代码不包含 shell operator、转义、展开、substitution、分组或重定向语法。

其他所有输入均原样使用现有切分器。因此，不支持的语法可以继续多弹一次确认，但不会因为本次改动获得更宽松的 allow 判定。

## 风险与约束

支持的子集刻意保持很窄。任何扩展都必须以真实 shell parser 的证据为基础，不能由单个 review 样例驱动。等 #11882 明确 parser ownership 后，应优先以现有异步 `parseShellCommand` parser 作为更广泛 Bash 语义的基础。

该快速路径只覆盖四条 `Bash(...)` 规则路径。同一个 `evaluate()` 中的虚拟 shell-operation 通路仍然对完整命令调用 `extractShellOperationsAcrossCommand`——它必须如此，因为该调用是 `cd` 与递归 shell wrapper 下 cwd 跟踪的唯一事实来源——而 `walkCompoundCommand` 及其委托的 `splitCompoundCommandSegments` 都完全没有 `#` 处理。因此 `Read`/`Edit`/`Write`/`WebFetch` 规则仍会针对被注释掉的文本评估，被注释掉的 `rm`、`cat` 或 `curl` 可能产生一个幻影 operation 并升级判定。该残留只升不降，且早于本 PR 存在（本 PR 未触及 extractor 通路）：两个判定只有在 `DECISION_PRIORITY[virtual] > DECISION_PRIORITY[bash]` 时才合并，所以幻影 operation 只会过度 deny 或过度 ask，绝不会放宽 allow。要消除它需要两个所有者共用同一个切分决策，那属于 #11882 的 parser ownership 工作。

在仅配置 deny 规则的情况下，快速路径还会把含注释命令的判定从 `deny` 变为 `ask`。配置 `deny: ['Bash(rm *)']`（无 allow 规则）时，`echo 'a' # comment ; rm -rf /tmp/x` 在 merge base 上会被硬拦截，因为无注释感知的切分把 `rm -rf /tmp/x` 暴露成独立 segment；而这里整条命令保持为一个 segment，于是 `findMatchingDenyRule` 与 `hasRelevantRules` 都为空，判定落到工具默认的 `ask`。这正是本修复的预期方向——Bash 只执行注释前的 `echo`，关于 `rm` 的规则无可匹配——并且无法在不破坏「允许的 `echo` 判定为 `allow`」这条验收标准的前提下回退：任何在隐藏 segment 命中 deny 时就退出的门禁，在 allow+deny 的情况下同样会退出。

残留风险位于该 `ask` 的另一侧。现在落到的确认对话框仍使用旧的、无注释感知的切分器（见上文「非目标」，由 #11882 负责），所以对这条命令它会把 Bash 永远不会执行的 `rm -rf /tmp/x` 列为可确认子命令，并由 `extractCommandRules('rm -rf /tmp/x')` 得到 `permissionRules: ['Bash(rm *)']`。因此点一次「Always allow」就会把一条宽泛的 `Bash(rm *)` allow 规则持久化进 `settings.json`，而这完全由注释内的文本驱动。在操作者自己的 deny 存在期间它保持惰性（实测：两条规则同时存在时 `rm -rf /tmp/x` 仍判定为 `deny`），一旦该 deny 被修改或移除即刻生效（实测：仅有 allow 时判定为 `allow`）。在 #11882 收敛对话框切分器之前，依赖 deny-only 配置的操作者应把含注释命令上被提议的 `Bash(...)` allow 规则视为不可信，而不是把它当成对 shell 实际执行内容的描述。

## 验证与验收标准

- #11815 的命令在 Bash 下只有一个 segment，允许的 `echo` 判定为 `allow`。该标准只针对 `Bash(...)` 规则：它假设没有任何 `Read`/`Edit`/`Write`/`WebFetch` 规则匹配被注释掉的文本，而虚拟 operation 通路仍会读取这些文本（见「风险与约束」）。
- 同一段文本在 `cmd` 和 PowerShell 下仍会切分。
- 多行命令、包含 substitution 语法的命令，以及注释前存在 operator 的命令保持旧的保守切分。
- 首个非空白字符是 `#` 的命令（无论位于下标 0 还是在前导空格/制表符之后）同样保持旧的保守切分，因此显式 `deny` 规则仍能匹配注释之后的文本。
- `monitor` 命令中只存在于 wrapper 内层引号里的 `#` 仍会切分，因此 spawned 命令真正执行的分隔符不会被当成注释吞掉。
- 在仅配置 deny 规则的情况下，同一条命令判定为 `ask` 而非 `deny`。这是有意钉住的行为，不是偶然结果：`ask` 落到的对话框仍会用旧切分器提议规则（见「风险与约束」）。
- 现有 permission-manager 测试、格式化、lint、typecheck 和 build 检查通过。
