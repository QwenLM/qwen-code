# `.mcp.json` 环境变量展开 — 设计

[English](2026-09-11-mcp-json-env-expansion.md) | [简体中文](2026-09-11-mcp-json-env-expansion.zh-CN.md)

**日期：** 2026-09-11
**状态：** 评审中（PR #11501）
**相关 issue：** #11499, #4615, #4466, #6131, #8653
**相关 PR：** #11501, #4474, #4713, #6177

---

## 问题

`.mcp.json` 随仓库一起提交，因此按名称引用密钥是配置需要鉴权的服务器的唯一安全方式——但占位符曾被原样发送。配置为 `"Authorization": "Bearer ${MY_TOKEN}"` 的服务器收到的请求头是 `Authorization: Bearer ${MY_TOKEN}`，返回 401，界面上只显示"Disconnected"，没有任何线索指向原因。

这是 qwen-code 内部的不一致，而非新功能：字节相同的服务器条目从 `.qwen/settings.json` 读取会展开，从 `.mcp.json` 读取则不会。#4466 / #4474 已把 `settings.json` 中 MCP 请求头的展开确立为正确行为；`.mcp.json` 是后来（#4713）加入的，没有沿用。这一格式来自 Claude Code，其文档记录了 `command`、`args`、`env`、`url` 和 `headers` 中的展开，以及同样的"未设置则保留占位符"行为。本设计不加入 Claude 的 `${VAR:-default}` 语法——只做普通展开，与 qwen 的解析器在其他位置已支持的能力一致。

解析器是 `resolveEnvVarsInObject`（`packages/core/src/utils/envVarResolver.ts`），与所有 settings 作用域共用；加载器是 `loadProjectMcpServers`（`packages/cli/src/config/mcpJson.ts`），经 `assembleMcpServers` 从六个调用点到达：配置启动（`loadCliConfig`）、settings 文件热重载（`hot-reload.ts`）、ACP 工作区重载（`acpAgent.ts`）、`qwen mcp list`、`qwen mcp approve` 和 `qwen mcp reconnect`。

---

## 1. 展开限定在字段白名单内，这不是与 settings 的对等

早期版本把整个服务器条目交给 `resolveEnvVarsInObject`，并称之为与 settings 作用域对等。评审指出这会悄然开始展开 `description` 和 `extensionName`，而没有任何已发布版本展开过它们。修正改变了结论的形态，因此这里把差异明说。

`loadSettings` 解析整个 settings 文档，所以其中每个字符串都会展开。本加载器不这样做。它展开一个显式白名单，其余字段逐字节保持不变，包括 `description`、`extensionName` 和 `includeTools`。白名单为：

- stdio：`command`、`args`、`env`、`cwd`
- SSE / streamable HTTP：`url`、`httpUrl`、`headers`
- WebSocket：`tcp`
- OAuth：`oauth`——`MCPOAuthConfig.clientSecret` 正是提交到仓库的文件必须引用而不能内嵌的那类值
- Google 鉴权：`targetAudience`、`targetServiceAccount`——它们决定模拟哪个身份、为哪个受众签发令牌，因此决定连接以什么身份鉴权，而且正是随环境变化的值（项目编号、服务账号名）

`authProviderType` 有意不在名单中。它从固定枚举（`google_credentials`、`dynamic_discovery`、`service_account_impersonation`）中选择提供方；值是常量而非随环境变化的量，占位符放在那里没有收益。

因此 `.mcp.json` 刻意比 settings 作用域更窄，原因有二。`.mcp.json` 由仓库提供，在获批前不受信任，`~/.qwen/settings.json` 则不然；展开是提交文件读取环境的通道，所以它只覆盖确实需要的字段。而 `description` / `extensionName` 恰是 `packages/core/src/mcp/configHash.ts` 归为非行为字段、从审批摘要中剔除的字段——展开一个按定义无法影响服务器行为的值毫无收益。白名单也比 `configHash.ts` 定义的"行为字段"更窄：`includeTools`、`excludeTools`、`timeout` 和 `trust` 都计入审批摘要，但都不展开。

在首轮评审后的修订（`4d024d692f`）中加入的 `--mcp-config` 展开有意**不**遵循这条更窄的规则：`parseMcpConfig` 解析整个对象，包括元数据，即与 settings 完全对等。这种不对称正是设计意图。`--mcp-config` 由运行命令的操作者传入，与他们自己拥有的 settings 文件无异；`.mcp.json` 则由仓库提供，在获批前不受信任。因此带 `$` 的 `description` 在两个来源之间行为不同，这是有意为之。没有任何机制核验 `--mcp-config` 路径的作者身份——操作者选择传入该路径本身就是信任决定，且 `--mcp-config` 的服务器不受门控，这早于本次改动。

---

## 2. 有意不传入 `getHomeEnvFallbackVars()`

#11499 的分诊要求加入 home `.env` 回退，理由是只存在于 `~/.qwen/.env` 的令牌会在 `.qwen/settings.json` 中展开，而在 `.mcp.json` 中保持字面量。这一情形无法复现：`loadSettings()` 在六个调用点中的任何一个读取 `.mcp.json` 之前就会调用 `loadEnvironment()`（`settings.ts`，位于 `loadSettings` 内部，除非调用方传入 `skipLoadEnvironment`，而六个调用点均未传入），因此来自 `~/.qwen/.env` 的键已在 `process.env` 中，可以正常展开。

传入回退反而有害。`getHomeEnvFallbackVars()` 既不过滤 `isLoaderEnvKey` 也不过滤 `isPrivateProvenanceEnvKey`，而 `loadEnvironment` 在所有作用域都拒绝这两类键，所以回退在 `process.env` 之上新增的键恰恰是环境加载器刻意扣下的——其中包括 `NODE_OPTIONS`。把它接入一个受仓库控制、获批前不受信任的文件，等于让提交的 `.mcp.json` 恰好读到这些值：这是 #8653 的攻击向量，而非修复。

有测试固定这一点：设置临时 `QWEN_HOME`，在其中写入包含普通键和 `NODE_OPTIONS` 的 `.env`，断言 `getHomeEnvFallbackVars()` 确实暴露两者——使测试不可能空洞通过——然后断言两者都未被替换进 MCP 配置。仍有一处残余差异：启动后新加入 `.env` 文件的变量，ACP 工作区重载能看到（它重新调用 `loadSettings()`，从而重新运行 `loadEnvironment()`），settings 监视器热重载则看不到（它从磁盘重载作用域而不触碰环境）。

读取 `.mcp.json` 时 `process.env` 中已有的 `.env` 文件：`findEnvFiles` 从项目目录向上查找，取找到的第一个 `<dir>/.qwen/.env` 或 `<dir>/.env`——工作区文件仅在该工作区受信任时采用——再加上 home 候选：`<QWEN_HOME>/.env`、`QWEN_HOME` 重定向时的旧版 `~/.qwen/.env`，以及 `~/.env`。因此检出的仓库可以自带一个 `.env` 来提供其 `.mcp.json` 占位符解析出的值；这一步的门槛是工作区信任，而审批门控仍然作用于服务器本身。

---

## 3. 嵌套深度上限，因为解析器是递归的

`resolveEnvVarsInObject` 递归而无深度界限，所以恶意或生成的 `.mcp.json` 可能耗尽调用栈，让 `qwen`、`qwen mcp list` 和 `qwen mcp approve` 以 `RangeError` 崩溃而不是给出诊断。

在 node v24.11（win32）上对构建后的解析器实测：嵌套**数组**在空进程中约 2000–3000 层之间抛出，且边界不稳定——随 JIT 状态在多次运行间移动，因此是一个区间而非数字。打包后的 CLI 内 2000 的数字与此一致，因为加载器运行时启动过程已消耗部分栈。数组经 `Array.prototype.map` 递归，每层比对象分支占用更多栈；嵌套**对象**在 5000 层仍存活，到 10000 层抛出。`JSON.parse` 在这些深度均不抛出——它能解析 100000 层——所以加载器原有的 parse `try/catch` 从未覆盖此情形。

阈值随 V8 版本和调用方剩余栈空间变化，这正是采用固定上限而非试图计算安全深度的理由。`MAX_MCP_SERVER_CONFIG_DEPTH = 64` 比任何真实配置高出数个量级（`env`、`headers` 和 `args` 只嵌套两三层）。超过上限的条目通过加载器已有的 `errors` 集合上报并跳过，因此病态文件只损失那一个服务器，而非整个进程。深度探测（`exceedsMaxDepth`）本身是迭代实现——递归探测会在它本该拒绝的输入上溢出。逐条目的 `try/catch` 作为后备，使加载器文档化的"绝不抛出"契约完整。探测不带 `seen` 集合：输入总是 `JSON.parse` 的输出，即有限树；若真有环传入，也会因超过上限而终止。

深度从服务器条目起算（条目 = 1），三个递归消费者相对它的起点不同：`parseMcpConfig` 把整个服务器映射交给解析器，比条目高一层，因此最多递归上限 + 1；`hashMcpServerConfig` 序列化条目本身，为上限；`resolveTransportEnvVars` 把条目的一个字段交给解析器，为上限 − 1。`parseMcpConfig` 对 `--mcp-config` 施加同一上限，在那里整体明确失败——它是操作者的显式参数——而 `.mcp.json` 只跳过那一个条目。

---

## 4. 审批哈希在解析之后计算，有意为之

分诊称这是真实的副作用："沿用它是一致性而非新颖性，但确实延伸了已有的疙瘩"。决定是沿用，且在决定前复现了两个方向。对同一 `${TOK}` 请求头的项目服务器和工作区服务器都批准后，两个文件不动、轮换变量，**两者**都回到 `pending`——工作区作用域服务器在 `main` 上今天就如此，因此这是让 `.mcp.json` 与已发布行为对齐，而非发明新行为。

另一方案也测过，更差。对解析前的原始文本哈希，会让审批在*有效*配置变化后仍然有效：`httpUrl: "https://${HOSTVAR}/mcp"` 在 `HOSTVAR` 被改指后解析为 `https://attacker.test/mcp`，却仍算已批准。哈希的意义在于把决定绑定到用户审阅过的确切配置，而按 `packages/core/src/mcp/configHash.ts` 的定义 `url` / `headers` 是行为字段，因此绑定解析后的形态是这一权衡中安全正确的一端。存储的记录是 SHA-256 摘要，不会把密钥写入审批文件。代价正是分诊指出的：轮换令牌，或同事使用自己的密钥，会重新触发审批。这是合理的代价，也是工作区作用域已在支付的代价。

评审真正改变的是这一行为此前没有任何*披露*。审批对话框和一条文档注释曾有误导，两者都仅在文本层面修正——哈希逻辑未动：

- 审批对话框称审批绑定到此确切配置、"若 `.mcp.json` 变化"会再次询问，遗漏了环境变量这一半；现在也提到被替换的变量值发生变化的情形；
- `mcpApprovals.ts` 记录了摘要却未说明它是对*解析后*配置计算的，读者会合理地以为哈希的是文件字节；文档注释现在记录了这一点，以及原始文本方案为何更差。

---

## 5. 审批门控关闭时不展开（`--yolo`、bare 模式、safe 模式）

第三轮评审在上一修订中发现了漏洞；对此的决定记录在这里，而不是从 settings 作用域的做法中默默继承。

展开仓库提供的文件之所以安全，前提是用户在任何连接建立前能看到服务器。`--yolo` 跳过 MCP 审批提示（#6177，关闭 #6131），所以在 `--yolo` 下这一前提不存在：被克隆的仓库可以在自己的 `headers` 里写任意变量名，让真实值被发送到作者选定的端点。在本改动之前同一文件只会泄露字面占位符，因此上一修订在这条路径上引入了回归。bare 和 safe 模式完全丢弃 `.mcp.json`，从未暴露，但它们关闭的是同一个门控，由同一条件处理。

**决定：当且仅当审批门控已启用时，展开 `.mcp.json` 占位符。** 条件——`!bareMode && !safeMode && approvalMode !== YOLO`——只存在于一处，`mcpApprovals.ts` 中的 `isMcpApprovalGateArmed(bareMode, safeMode, approvalMode)`，并在门控可能关闭的三个调用点为 `expandEnv` 供值：启动（`loadCliConfig`）、settings 文件热重载（`hot-reload.ts`）和 ACP 工作区重载（`acpAgent.ts`）。同一个值决定是否计算 `pendingMcpServers`——启动时直接使用，两条重载路径上作为 `recomputeMcpGating` 的参数——因此两个决定是同一次调用，不会分离。ACP `session/new` 和 ACP 工作区 MCP 发现配置都通过 `loadCliConfig` 构建 `Config`，所以谓词在会话创建时同样生效，而不只在重载循环中。因此在 `--yolo` 下，`.mcp.json` 服务器以字面占位符连接——与 `main` 今天的行为完全一致，对门控会话本改动修复的 401 在那里依旧，但不会泄露任何东西——加载器会通过 `errors` 上报，在 stderr 上以警告点名该服务器。bare 和 safe 模式根本不加载 `.mcp.json`。

这也包括用户此前用 `qwen mcp approve` 批准过的服务器：在 `--yolo` 下它同样收到字面量，因此 #11499 的 401 在"检出仓库后无头运行"的 CI 场景中依然存在。替代方案——展开、对结果哈希、若摘要匹配已存审批则保留，否则回退到字面量——已考虑并否决，因为它在核对同意之前就展开了值，而这正是本决定要避免的动作；新检出的 CI 环境也没有可供匹配的审批存储。门控启用时用户审阅的内容也比"服务器"更窄：对话框的 `summarize()`（`useMcpApproval.ts`）显示解析后的 `url` / `command` / `args`，但 `env` 和 `headers` 只显示键名，所以它展示的是连接到哪里、运行什么，而不是某个请求头读取了哪个变量。

`qwen mcp list`、`qwen mcp approve` 和 `qwen mcp reconnect` 保持默认的 `expandEnv: true`。三者都没有 `--yolo`，其路径上门控始终启用：`list` 打印未批准的门控服务器而不连接，只对已批准的做实时连接测试；`reconnect` 无条件把 `getPendingGatedMcpServers` 传入其一次性 `Config`，因此发现阶段在 `discoverToolsForServer` 运行前跳过待审批服务器；`approve` 从不连接。它们也必须继续展开：审批摘要是解析后配置的摘要（第 4 节），在那里收窄展开会悄然使正常启动时做出的所有审批失效。

为何选这一方案而非另外两种：

- _让 `--yolo` 对门控服务器提示或拒绝。_ 这会推翻 #6177——它让 `--yolo` 跳过提示，使无头和非交互运行既不会卡在对话框上也不会悄然丢弃服务器（#6131）。本改动关乎解析器，而非 `--yolo` 的含义。
- _在 `--yolo` 下继续展开。_ 漏洞仍然敞开。

门控展开是唯一既保持 `--yolo` 语义不变、又不让仓库文件在无人过目时把变量名变成值的方案。

运行时切换到 YOLO 不会重新打开这一漏洞。`pendingMcpServers` 在构造时设定（`packages/core/src/config/config.ts` 构造函数），由 `setPendingMcpServers` 替换、由 `approveMcpServerForSession` 收窄——没有任何操作会重新加入服务器——`isMcpServerPendingApproval` 只读取它，所以 `setApprovalMode(YOLO)` 之后待审批的服务器仍是待审批；切换后的热重载以门控关闭重新计算，因而不展开——这为任何新条目关上了漏洞，而对已批准并已连接的服务器，则是下文所述的限制。

**已知限制——会话中途切换到 YOLO。** 会话以门控启用启动、批准某服务器并以解析后的凭据连接，随后切换到 YOLO（`/approval-mode yolo`、Shift+Tab 循环、ACP `session/set_mode`），则在下一次 settings 重载时——任何编辑，无论是否与 MCP 相关——该服务器被改写为字面形态：传输指纹变化，连接被拆除并以占位符重建，服务器持续 401，直到切回模式并再次重载；加载器的警告会在 stderr 上点名它。这里不修复。若每会话只决定一次展开，会为切换后新加入 `.mcp.json` 的服务器重新打开本节关闭的漏洞——它会展开并在无人询问的情况下连接；若保留已解析的条目，则是逐条合并，却没有把已解析条目与其未解析后继匹配起来的判据。守护进程中按 `Config` 存在同样的限制：审批模式不同的会话各自组装映射，因此同一个 `.mcp.json` 服务器可能持有两条凭据不同的连接。

**审批存储只从门控启用的 `Config` 读写。** 存储是每个工作区一条记录，摘要针对会话所持有的配置形态；门控关闭的会话持有未展开的 `.mcp.json`，其摘要永远不会与从展开形态记录的审批匹配。若不加守卫，`--yolo` 守护进程或 TUI 会话会把已批准的服务器报告为待审批，并在批准时持久化字面摘要，随后每次门控启用的启动都拒绝它（2026-09-11 针对 `e1aa3572e4` 的自动评审测得 `--yolo` 守护进程与 CLI 之间 4/4 的乒乓）。因此三个读取点——守护进程工作区状态、ink `/mcp` 对话框、OpenTUI 对话框数据——从门控关闭的 `Config` 不报告任何审批状态，两个写入点——守护进程 `workspaceMcpManage approve` 端点和对话框的 Approve 操作——予以拒绝。若改为规范化到展开形态，就要在 `--yolo` 下为哈希展开 `.mcp.json`——正是本节要避免的动作——还会向用户展示字面量却绑定到展开值。`qwen mcp approve` 继续对展开形态哈希：收窄它会使已写入的所有存储失效。代价：在 `--yolo` 下，`/mcp` 对话框和守护进程端点不再提供预审批——`qwen mcp approve` 仍可用——而以 YOLO 启动的守护进程不向 IDE 展示审批状态，在 YOLO 下它本来也不影响连接。

工作区作用域的 `.qwen/settings.json` 在 `--yolo` 下今天行为相同：其服务器由 `loadSettings` 解析，与审批模式无关，因此门控的工作区服务器在 `--yolo` 下以真实值连接。在此点明是为了让先例显式化，而不是把它当作 `.mcp.json` 漏洞可以接受的理由。本改动不修改 settings 解析，上述决定独立成立：`.mcp.json` 随仓库到来而非由用户书写，这正是这里修复该文件的原因。

解析读取进程范围的 `process.env`，与所有 settings 作用域一样；解析器没有按工作区的视图，这里也不引入。

测试：加载器（`mcpJson.test.ts`：`expandEnv: false` 保留 `${VAR}` 字面量，默认和显式 `true` 展开）；`assembleMcpServers`（`mcpServers.test.ts`）；谓词真值表（`mcpApprovals.test.ts`）；以及三个调用点各一。启动：`config.test.ts` 模拟了 `fs.writeFileSync`，无法放置真实 `.mcp.json`；测试用透传 spy 包装 `assembleMcpServers`，断言 `loadCliConfig` 在 `--yolo`、`-y` 和 `--approval-mode yolo` 下传入 `{ expandEnv: false }` 且没有 `pendingMcpServers`，默认传入 `{ expandEnv: true }` 和计算出的 `pendingMcpServers`。settings 热重载（`hot-reload.test.ts`）和 ACP `workspaceMcpReload`（`acpAgent.test.ts`）：临时项目目录中带 `${VAR}` 的 `.mcp.json` 经真实加载器加载，断言交给 `reinitializeMcpServers` 的映射在 YOLO 下为字面量、在 DEFAULT 下已展开；热重载用例同时断言 `pending` 这一半（YOLO 下无，DEFAULT 下为 `['proj']`）。每个调用点都做了变异检查——在该点强制 `expandEnv: true` 使其 YOLO 用例失败（启动：3 失败 / 1 通过；热重载：1 / 1；ACP 重载：1 / 1）。摘要：`approve.test.ts` 批准一个请求头引用变量的服务器，对加载器默认值断言 `approved`（因此 `qwen mcp approve` 与启动哈希同一形态），再在文件不动的情况下改变变量并断言 `pending`。存储守卫：ink 对话框（`MCPManagementDialog.test.tsx`）和 OpenTUI 对话框数据（`dialog-data.test.ts`）从 YOLO `Config` 不携带审批状态，守护进程 `workspaceMcpManage approve` 端点（`acpAgent.test.ts`）从这样的 `Config` 拒绝。

---

## 非目标

- Claude 的 `${VAR:-default}` 语法。
- 字面 `$` 的转义——共用解析器没有 `$$` 形式，加入它会改变所有 settings 作用域。
- 在审批前遮蔽 `qwen mcp list` 中解析出的密钥——同样的暴露已通过本改动未触及的代码在工作区作用域发布，因此该规则应放在两个门控作用域共用的显示路径中。
- 改变 `--yolo` 对 MCP 审批的含义（#6177），或工作区作用域 settings 在其下的解析方式。
- 扩展提供的 MCP 服务器：扩展管理器整体解析 Qwen 格式的清单，没有门控输入，且扩展服务器从不受审批门控。第 5 节的"当且仅当"仅限于 `.mcp.json` 加载器。
