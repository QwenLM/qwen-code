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

- 每个 `DiscoveredMCPTool` 都声明 `permissionAliases`：首先是**精确的原始身份** `mcp__<server>__<tool>`，然后是与之不同的 legacy `generateLegacyMcpToolName` 归约拼写。逐字注册的 provider 安全名字没有任何损失，因此不声明 alias。注册表（`ToolRegistry.getPermissionAliases`）与调用对象（`permissionFlow.ts`）读取的是同一个数组。
- 一个 alias 只有在它自己的归一化结果**就是**注册名时，才会被接受为该工具的原始身份，因此另一个 server 的工具永远无法提供规则所匹配的原始身份。原始前缀来自用户配置中的 server 键，而不是来自 server。唯一的例外是三段式精确条目：它们还会把已发布的 legacy 归约作为完整字符串额外匹配，不做上述归一化校验；授权还必须通过下方的注册表歧义检查。
- 精确、server 级与通配模式随后与注册名、原始身份，以及下一条所述经过闸门的 legacy 归约做**字面**比较。在这个匹配器内部不做任何重建，也不做任何哈希：尾部只是模仿归一化哈希的注册名什么也证明不了。早期的设计会重建候选原始名并用无密钥的 FNV-1a 名字哈希做验证；那只能证明一个存在性命题（规则前缀下存在某个原始名归一化后等于该注册名），而且可以被伪造，因此被删除而不是再加闸门（#10199）。
- 授权匹配仅在 legacy 归约仍能为其 server 作证时读取它。限制型匹配还会使用下文所述由生产方身份派生的拼写。字符替换会保留 server 段的可识别性；超过 63 字符时 `generateLegacyMcpToolName` 会截成 `slice(0, 28) + '___' + slice(-32)`。挺过 28 字符头部窗口是必要而不充分的：`_` 在两段中都合法，因此只在分隔符周围有差异的两个短键（`acme-weather-forecast` 与 `acme-weather-forecast_`、`github` 与 `github__create_reposito`）可能被压平成逐字节相同、扁平化比较无法归属的归约。作证判定只在唯一的发布点做出一次：仅当窗口还能钉住键的结束位置时——整个 `__` 分隔符落在窗口内，或键恰好结束在窗口边缘，且键的 legacy 映像不含 `__`、也不以 `_` 结尾（`legacyReductionVouchesForServer`）——`permissionAliases` 才发布被截断的归约。截断触及 server 段时只剩其前 23 个字符，两个不同的长键可能落进同一个逐字节相同的窗口，那样的归约同样不能用于授权任何一个 server。基于拼写的匹配器通过 alias 成员关系消费这份发布——`__` 在 `mcp__<server>__<tool>` 的两段中都不是保留分隔符，且归约会改写字符，因此无法从扁平化后的拼写反推 server 边界。发布 legacy alias 后，前缀分支使用原始身份的保长历史字符替换。它包含归约中可靠的头部，但没有注入的 `___`，因此无需另行保留截断窗口。精确条目仍比较完整的已发布拼写。
- 基于生产方身份的通配匹配从 provider 安全的 server 边界提取注册工具段，独立于规则所用的 server 拼写。因此，`foo.bar/get+data` 上的 `mcp__foo.bar__get_data_*` 以及到达注册名哈希或截断位置的前缀，仍然命中自己的工具；限制规则不会因此失效。
- `disabledTools` 根本不会到达 `rule-parser.ts`。`ToolRegistry.isToolDisabled` 单独匹配它：既按精确集合成员关系读取不经过来源闸门的 `disabledToolAliases` 数组，也仍然把 `normalizeMcpToolName(条目)` 与注册名做比较，因此历史拼写的条目也可能禁用另一个冲突 server 的工具。该归一化分支早于 #10199 存在且是失效关闭的——请勿仅凭本文档就删除它而不做一次行为决策。
- legacy 的 `sanitizeToolNameForProvider` 归约被特意从匹配中移除：它让 `mcp__foo.bar` 规则能命中以不同名字注册的 server `foo_bar`。请勿重新引入。纯逐工具匹配仍接纳 provider 和历史拼写，以保留兼容性和限制覆盖。如果 allow 命中依赖有损拼写，且当前会话注册表中另一个原始身份认领了同一 server 拼写或完整工具渲染，则拒绝该授权。因此，同时注册了 `foo_bar` 时，`mcp__foo_bar`、`mcp__foo_bar__*` 和历史精确条目不能授权 `foo:bar`。已发布的同一个中间截断历史 alias 也不能授权两个不同工具中的任一个。通配授权对照当前注册的生产方身份解析 server 边界。完整的原始整 server 边界选择该 server；处于同一连续下划线分隔符内的边界，按规则明确写出的原始 server 段归属。若边界位于不同分隔位置，则工具前缀存在歧义，双方都需确认。因此，`mcp__foo____i*` 在 `foo/__internal_debug` 与 `foo_/_internal_secret` 之间选择前者，`mcp__foo__*` 在 `foo` 与 `foo__bar` 之间选择前者；同时注册 `foo/bar__deploy_x` 与 `foo__bar/deploy_y` 时，`mcp__foo__bar__deploy*` 对双方都要求确认。没有完整边界的有损或截断头部，若另一注册渲染同样认领它，就不能授权。原始精确规则和唯一的精确注册名保留优先权。裸整 server 规则支持包含 `__` 的键，但若另一个身份的完整工具名认领同一字符串，就不能授权该 server。单一生产方的下划线工具前缀以及 `mcp__foo*` 等有意书写的原始粗前缀仍有效；单一认领者的 alias 保留兼容行为。权限判定和相关规则检查都执行此闸门。每次判定同时读取模型可见和仅供 App 使用的工具注册表，按原始身份去重，注册和移除立即生效，无需缓存 alias 表。Deny、ask 和 `disallowedTools` 按下文边界条件保留限制覆盖；`disabledTools` 的匹配不变。没有注册表的直接匹配器调用仍是兼容谓词，不能单独作为无歧义的授权依据。
- 裸 `*` 不是 MCP 模式，不匹配任何 MCP 工具；`mcp__*` 和 `mcp__server__*` 保持其文档语义。
- 限制型规则（`deny`、`ask` 和 `disallowedTools`）还会匹配从生产方传入的 `mcpIdentity` 生成的原始和历史拼写，即使 alias 发布闸门扣留了 legacy 归约。这保留了精确限制以及长 server key 上忠实的历史前缀。现有的身份匹配器保留生产方的 server/tool 边界；注册名被截断后的前缀还可限制所有匹配者。前缀以该 key 的原始、provider-safe 或 legacy 拼写停在其自身 server 分隔符处或分隔符内时，限制该 key 的所有工具（包括以 `_` 开头的工具）；这与 `main` 一致，且只用于限制型规则。如果多个工具共享有损的限制拼写，它们都会受限；需要仅限制其中一个时，应使用精确注册名。`allow` 绝不使用此兜底，也不发布额外的 alias 通道。
- 不对称性：失去匹配可能移除显式限制，而可信服务器随后可能无需提示就执行。因此，执行路径同时传递已发布的 alias 和生产方身份。没有身份的调用仍保持经过闸门的拼写匹配；没有实时注册表的调用不能证明通配授权无歧义。

## 验证

- 针对合法、非法、冲突、超长、稳定与幂等名字的单元测试。
- 针对注册、权限规则、重连查找与禁用工具的 MCP 工具测试。
- 冲突测试（`mcp-server-rule-collision.test.ts`）：跨 server 伪造 witness（精确、server 级与通配三种形状）、中间截断过度匹配、历史拼写 deny 覆盖，以及无 alias 姿态。
- 针对含带点 MCP 名字的恢复历史的 OpenAI 与 Anthropic 转换器测试。
- 使用真实生产方身份的注册表授权测试：安全与非安全 server 配对、两个非安全认领者、同 server 的精确工具 alias、共享中间截断、运行时注册/移除、单一认领者兼容、原始及粗前缀规则，以及未改变的 deny/ask 覆盖。
- core 包的构建与类型检查。
