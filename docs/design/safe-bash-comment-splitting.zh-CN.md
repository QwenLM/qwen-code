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
- 让所有 Bash-rule 消费者使用同一个切分决策。

## 非目标

- 完整解析 Bash 注释或 heredoc。
- 修改虚拟 shell operation 提取或 cwd 跟踪。
- 收敛自定义命令使用的另一套旧切分器；该工作由 #11882 负责。

## 设计

`PermissionManager` 从 `getShellConfiguration()` 读取当前 `ShellType`。它的四个 Bash-rule 路径统一调用现有切分器外的一层 shell-aware 包装。

只有同时满足以下条件时，该包装才把原命令保留为一个 segment：

- 当前 shell 是 `bash`；
- 命令只有一个物理行；
- 引号外的 `#` 位于空格或制表符之后；
- `#` 之前的代码不包含 shell operator、转义、展开、substitution、分组或重定向语法。

其他所有输入均原样使用现有切分器。因此，不支持的语法可以继续多弹一次确认，但不会因为本次改动获得更宽松的 allow 判定。

## 风险与约束

支持的子集刻意保持很窄。任何扩展都必须以真实 shell parser 的证据为基础，不能由单个 review 样例驱动。等 #11882 明确 parser ownership 后，应优先以现有异步 `parseShellCommand` parser 作为更广泛 Bash 语义的基础。

## 验证与验收标准

- #11815 的命令在 Bash 下只有一个 segment，允许的 `echo` 判定为 `allow`。
- 同一段文本在 `cmd` 和 PowerShell 下仍会切分。
- 多行命令、包含 substitution 语法的命令，以及注释前存在 operator 的命令保持旧的保守切分。
- 现有 permission-manager 测试、格式化、lint、typecheck 和 build 检查通过。
