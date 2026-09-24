# MCP 工具名 Provider 兼容性

[English](mcp-tool-name-provider-compatibility.md) | [简体中文](mcp-tool-name-provider-compatibility.zh-CN.md)

## 问题

Qwen Code 目前按 Gemini 的字符集接受 MCP 工具名。诸如 `literature.search_pubmed` 这样的名字会变成 `mcp__server__literature.search_pubmed`，Gemini 能接受，但更严格的 OpenAI 兼容与 Anthropic 兼容端点可能在工具运行前就拒绝它。

同一个原始名会在注册、权限持久化、重连查找、输出截断和恢复的历史记录中被各自独立地重建。如果只改 provider 请求，模型可见的名字就会与注册表键不一致。

## 设计

对 MCP 工具名使用一条确定性的 provider 安全归一化规则：

- 已匹配 `^[A-Za-z][A-Za-z0-9_-]*$` 且不超过 63 个字符的名字保持不变。
- 替换不支持的字符，确保首字符为字母，并在发生归一化或截断时追加一个稳定的短哈希。
- 最终名字保持在 63 个字符以内，Gemini 以及更严格的 OpenAI 兼容、Anthropic 兼容 provider 都接受。
- 在 MCP 调用的全过程中使用注册名，而不是从原始 server 名和工具名重建。
- 在恢复 OpenAI 与 Anthropic 请求历史时归一化 MCP 名字，使改动前创建的会话仍可发送。
- 通过携带由原始 server 名和工具名派生的**归一化前精确身份**，继续匹配历史遗留的 MCP 权限条目与禁用工具条目。这同时也保留了被此前中间截断算法截断过的名字，且不会放宽通配匹配。

不引入任何 provider 特定的 alias 表。合法的既有名字逐字节不变，因此 Gemini 行为和普通内置工具都不受影响。

由之前的中间截断算法产生的恢复名字已经是 provider 安全的，在历史消息中保持不变。它们被移除的中段无法可靠重建，因此转换器不会去猜一个新的哈希名字；精确权限与禁用工具兼容性改为使用 MCP 注册时可用的原始名 alias。

## 规则匹配

权限规则和 `disallowedTools` 阻止列表可能是用历史拼写（`mcp__foo.bar__tool`）书写的，它们不再等于注册后的 provider 安全名。匹配方式如下（`packages/core/src/permissions/rule-parser.ts`）：

- 每个 `DiscoveredMCPTool` 都声明 `permissionAliases`：首先是**精确的原始身份** `mcp__<server>__<tool>`，然后是与之不同的 legacy `generateLegacyMcpToolName` 归约拼写。逐字注册的 provider 安全名字没有任何损失，因此不声明 alias。注册表（`ToolRegistry.getPermissionAliases`，供 L1/L2 闸门）与调用对象（`permissionFlow.ts`，供 L4 调用期检查）读取的是同一个数组。
- 一个 alias 只有在它自己的归一化结果**就是**注册名时，才会被接受为该工具的原始身份，因此另一个 server 的工具永远无法提供规则所匹配的身份。原始前缀来自用户配置中的 server 键，而不是来自 server。
- 精确、server 级与通配模式随后与注册名和原始身份做**字面**比较。在这个匹配器内部不做任何重建，也不做任何哈希：尾部只是模仿归一化哈希的注册名什么也证明不了。早期的设计会重建候选原始名并用无密钥的 FNV-1a 名字哈希做验证；那只能证明一个存在性命题（规则前缀下存在某个原始名归一化后等于该注册名），而且可以被伪造，因此被删除而不是再加闸门（#10199）。
- `disabledTools` 根本不会到达 `rule-parser.ts`。`ToolRegistry.isToolDisabled` 单独匹配它：既按精确集合成员关系读取这同一个 `permissionAliases` 数组，也仍然把 `normalizeMcpToolName(条目)` 与注册名做比较，因此历史拼写的条目也可能禁用另一个冲突 server 的工具。该归一化分支早于 #10199 存在且是失效关闭的——请勿把上一条读成也覆盖了它，也请勿仅凭本文档就删除它而不做一次行为决策。
- legacy 的 `sanitizeToolNameForProvider` 归约被特意从匹配中移除：它让 `mcp__foo.bar` 规则能命中以不同名字注册的 server `foo_bar`。请勿重新引入。另一个方向上，用 provider 安全拼写书写的规则（`mcp__foo_bar`）仍然能字面命中任何归一化后落在该前缀下的 server——这是一处被接受的残留行为。
- 裸 `*` 不是 MCP 模式，不匹配任何 MCP 工具；`mcp__*` 和 `mcp__server__*` 保持其文档语义。
- 不对称性：失去匹配在 `allow` 上是失效关闭的（工具回退到 `ask`），但在 `deny`/`ask` 规则和 `disallowedTools` 阻止列表上是失效放行的，这正是每个可达调用方都必须接入 alias 通道的原因。

## 验证

- 针对合法、非法、冲突、超长、稳定与幂等名字的单元测试。
- 针对注册、权限规则、重连查找与禁用工具的 MCP 工具测试。
- 冲突测试（`mcp-server-rule-collision.test.ts`）：跨 server 伪造 witness（精确、server 级与通配三种形状）、中间截断过度匹配、各原始长度下的历史拼写 deny 覆盖，以及无 alias 姿态。
- 针对含带点 MCP 名字的恢复历史的 OpenAI 与 Anthropic 转换器测试。
- core 包的构建与类型检查。
