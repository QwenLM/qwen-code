# 客户端文件系统桥（Client Filesystem Bridge）设计

> 状态：设计草案（片2）。前置实证：片1 spike `.qwen/scripts/client-fs-spike/spike.mjs`（PASS，可重复运行）、片0 探针 `.qwen/scripts/fsa-probe/`。
> 关联：`packages/chrome-extension/docs/05-daemon-direct-architecture.md`、`packages/chrome-extension/docs/06-plan-c-cdp-tunnel.md`（issue #5626）。

## 0. 目标与非目标

**目标**：当 `qwen serve` daemon 跑在远端（云上）、Web Shell 跑在用户本地 Chrome 里时，让**指定会话**的 agent 能读写用户本机上一个**用户显式授权**的目录。

**非目标（v1 明确不做）**：

- 客户端侧 shell / git 执行 —— 浏览器里没有执行环境。
- 把客户端目录挂载成一个 workspace、让内置 `read_file`/`write_file` 直接路由过去 —— 需要给 core 加虚拟 FS 层，是架构级改动。
- 跨会话共享同一个桥 —— 与安全模型冲突（见 §5）。
- Firefox / Safari 支持 —— 没有 `showDirectoryPicker`。
- 删除类工具 —— FSA 能做到（实测 `removeRecursive: true`），但破坏性太强，v1 不暴露。

## 1. 为什么载体不是 CDP

CDP 隧道（Plan C）解决的是"操作用户真实浏览器里的页面"，与文件系统无关：`chrome.debugger` 只能对页面/标签下 CDP 命令，对本地磁盘只有"设下载目录""给 `<input type=file>` 塞文件"这类窄操作，不构成通用读写。

`native_directory_picker`（`packages/cli/src/serve/native-directory-picker.ts:29-56`）也不是答案：它在 **daemon 主机**上弹原生对话框（osascript / zenity），并显式排除 `SSH_CONNECTION` / `SSH_TTY`，远端 daemon 场景本来就不可用。

正确的既有资产是**反向工具通道** `client_mcp_over_ws`：浏览器侧客户端托管一个 MCP server，agent 调它的工具，执行发生在浏览器里。

## 2. 架构

```
Web Shell 页面（本地 Chrome，顶层标签页）
  ├─ File System Access API：showDirectoryPicker({mode:'readwrite'})
  │    句柄存 IndexedDB；刷新后 queryPermission → granted 则静默重连
  ├─ Web Locks API：多 tab 选主，只有 owner 持有桥
  ├─ 浏览器内 MCP server（手写 initialize / tools/list / tools/call）
  └─ WS：/acp（bearer 走 Sec-WebSocket-Protocol 子协议，同 TerminalPanel）
       ↓ ACP initialize → mcp_register { server:'local-files', sessionId }
daemon（父进程）
  ├─ ClientMcpWsConnection + ClientMcpRegistrar（帧关联，已存在）
  └─ 会话级 provider 变体（新增，~40 行）
       → ClientMcpSenderRegistry.setSession(name, sessionId, sender, owner)
       → bridge.addSessionRuntimeMcpServer(sessionId, name, {type:'sdk',
            __clientMcpOverWs, alwaysLoadTools:true}, owner)
ACP 子进程
  └─ sessionMcpRuntimeAdd → 只在该会话的 Config/ToolRegistry 里发现工具
       → SdkControlClientTransport → client_mcp/message → registry.lookup
       → 按 context.sessionId 找回浏览器侧 sender
```

刻意选择**复用 `/acp`**而不是新开 WS 路由：鉴权 / CSRF / host allowlist / 限流 / workspace-qualified 路径全部白拿（`packages/cli/src/serve/acp-http/index.ts:1600-1760`、`2069-2130`），而新路由要按 AGENTS.md 的归属规则重做一遍 scoping。代价是浏览器侧要实现 ACP `initialize`（约 30 行，扩展已证明可行）。

`/acp` 连接**懒开**：只在用户点「连接本地目录」时建立，断开即关。默认每个 tab 零成本，不挤占 ACP 连接预算。

## 3. 已验证的事实

全部为实测，非推断。片1 对**真实 daemon**（`npm start -- serve`，隔离 `HOME`/`QWEN_HOME`，零 repo 源码改动）跑通，`SPIKE: PASS`，exit 0。

| #   | 事实                                                                                                                                                                                                                                                                | 证据                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 反向通道对**非扩展**客户端开放：`clientInfo.name = qwen-client-fs-spike` 能连 `/acp`、过 ACP initialize、`mcp_register`                                                                                                                                             | 片1 A1                                                                                                                                         |
| 2   | 子进程把完整 MCP 握手打回浏览器侧：`initialize → notifications/initialized → prompts/list → resources/list → tools/list`，回 `mcp_registered toolCount=2`。parent WS ↔ registrar ↔ sender registry ↔ bridge ext-method ↔ child `SdkControlClientTransport` 全通 | 片1 A2                                                                                                                                         |
| 3   | `tools/call` 走同一条通道，已有测试覆盖                                                                                                                                                                                                                             | `packages/cli/src/serve/acp-http/client-mcp-ws.test.ts:235`（`round-trips register → tools/list → tools/call over the WS`），本次实跑 5/5 通过 |
| 4   | 注册后可观测：`GET /workspace/mcp` → `{mcpStatus:'connected', configOrigin:'runtime'}`                                                                                                                                                                              | 片1 A3                                                                                                                                         |
| 5   | 工具名 = `mcp__<server>__<tool>`，server 名进每个工具名                                                                                                                                                                                                             | 片1 A3：`mcp__spike-fs__spike_ping`                                                                                                            |
| 6   | `GET /workspace/tools` **不含** MCP 工具（只有 31 个内置工具）→ Web Shell 的 tools 面板不是桥的可见位置                                                                                                                                                             | 片1 A3c                                                                                                                                        |
| 7   | 关 WS → server 自动摘除，不留僵尸桥                                                                                                                                                                                                                                 | 片1 A4                                                                                                                                         |
| 8   | **注册需要活的 ACP 通道**：无会话时预热出的子进程会被回收，一次失败的 `POST /session` 也会打掉它，`mcp_register` 直接 `register_failed: No live ACP channel`。重新预热后 attempt 2 通过；有活会话时 attempt 1 通过                                                  | 片1 实测日志                                                                                                                                   |
| 9   | 一次 `mcp_register` 触发 **2 轮**完整握手（workspace Config + 每个活跃会话各一轮）→ N 个会话 = N+1 轮                                                                                                                                                               | 片1 `handshakeCount: 2`                                                                                                                        |
| 10  | 会话级隔离已实现且**硬拒绝**跨会话调用                                                                                                                                                                                                                              | `client-mcp-sender-registry.ts:165-183`；生产用例 `channel-worker-group.ts:258-330`                                                            |
| 11  | workspace 级注册会扇出到所有活跃会话，并被复制给之后每个新会话 → **绝不能用**                                                                                                                                                                                       | `acpAgent.ts:11727-11758`、`13443-13466`                                                                                                       |
| 12  | `alwaysLoadTools` 全仓只有一处设置（chrome-devtools）；WS provider 的 runtime config 里没有                                                                                                                                                                         | `acp-http/index.ts:253` vs `client-mcp-sender-registry.ts:243-247`                                                                             |
| 13  | MCP 工具默认走 `tool_search` 延迟暴露，模型要先搜才能调                                                                                                                                                                                                             | `integration-tests/sdk-typescript/sdk-mcp-server.test.ts`（假模型必须先 `tool_search select:mcp__sdk-calculator__calculate_sum`）              |
| 14  | FSA 机制全通：写 12ms / 读 1ms / 列目录 139 条 12ms / 建目录+建文件+递归删除 / **4,000,000 字符 21ms（≈190MB/s）** / 句柄存 IndexedDB 6ms                                                                                                                           | 片0 场景1（Chrome 151, macOS, `http://localhost:4321`）                                                                                        |
| 15  | 刷新后从 IndexedDB 取回句柄，`queryPermission({mode:'readwrite'})` = **`granted`** → 可静默恢复                                                                                                                                                                     | 片0 场景1 重载路径                                                                                                                             |
| 16  | **FSA 在跨源 iframe 中被禁**                                                                                                                                                                                                                                        | 片0 场景2（`127.0.0.1` 父页 + `localhost` 子 iframe）                                                                                          |
| 17  | `requestPermission()` 会**消耗** user activation → 无法与 picker 在同一次手势里完成，也无法自动触发                                                                                                                                                                 | 片0 `console-snippet.js` 的两次粘贴约束                                                                                                        |

由 14 修正两个早期判断：**目录遍历不慢**（139 条 12ms），慢的是逐文件取内容；**浏览器侧 I/O 不是瓶颈**（4MB 21ms），大小上限是 WS 传输与 daemon 侧的约束，不是 FSA 的。

## 4. 运行前提与降级矩阵

访问路径未固定（https 域名 / SSH 隧道到 localhost / 直连 http 都可能出现），因此**不能把 secure context 当作部署前提写死，必须运行时自检并分级降级**。`localhost` 被浏览器特判为可信源，所以本地结论不能外推到远端源。

| 条件                                                                       | 能力级别                                  | UI 行为                                                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 顶层标签页 + `isSecureContext` + Chromium                                  | 完整读写桥                                | 显示「连接本地目录」                                                                                                           |
| 跨源 iframe（扩展侧边栏形态）+ 其余满足                                    | 完整读写桥，但**不能在当前 frame 里授权** | 降级为「在新标签页打开以连接本地目录」（`window.open` 到 daemon 源顶层页面）                                                   |
| 同源 iframe / 顶层，但 `isSecureContext: false`（如 `http://<云IP>:端口`） | 无 FSA                                    | 隐藏读写桥，给出可执行建议：改用 https，或 SSH 隧道转发到 `localhost:<port>`（转发后即为可信源）；可选提供只读上传快照作为兜底 |
| 非 Chromium                                                                | 无 FSA                                    | 同上，说明浏览器限制                                                                                                           |
| `queryPermission` = `prompt`                                               | 需要一次真实点击                          | 显示「重新连接本地目录」按钮（事实 17：无法自动触发）                                                                          |
| `queryPermission` = `denied`                                               | 用户已拒绝                                | 引导去站点设置手动恢复，不提供静默重试                                                                                         |

frame 与 secure-context 检测逻辑可直接搬 `.qwen/scripts/fsa-probe/probe.html` 的「环境」段（`isTopLevel` / `parentOriginRelation` / `isSecureContext` / `typeof showDirectoryPicker`）。

## 5. 会话归属与授权（安全）

1. **必须 session-scoped。** workspace 级注册会让同 workspace 下**所有**会话——包括渠道消息（DingTalk 等）驱动的会话、后台 agent、别人的 tab——都能读写用户本地磁盘（事实 11）。会话级注册由 `client-mcp-sender-registry.ts:165-183` 硬拒绝跨会话调用（事实 10）。
2. **`mcp_register` 带 `sessionId`（已实现）。授权靠结构性保证，不是新检查。** `activeMount.bridge` 本身是 workspace 作用域的，`addSessionRuntimeMcpServer` 到子进程后走 `sessionOrThrow(sessionId)`，所以别的 workspace 的 sessionId 解析不到、直接 `register_failed`。**残余风险**：同一 workspace 内，任何通过鉴权的 WS 客户端都能绑定到该 workspace 的任意会话——这与该 workspace 其余 API 的信任级别一致，v1 接受；多用户共享单个 workspace 的场景需要额外的会话归属检查，留待后续。
3. **路径规则**：所有工具参数都是**相对授权根**的路径；拒绝绝对路径、`..`、反斜杠、URL 编码穿越（`%2e%2e%2f`）。授权根本身不可越出——这是 FSA 的天然边界，服务端仍要再校验一次。
4. **两层权限**：浏览器目录授权（粗，按目录，需用户手势）+ 现有 MCP 工具调用审批（细，每次调用）。事实陈述：yolo / 自动批准模式下，写本地盘不会再问。
5. **单 owner**：用 Web Locks API 在多 tab 间选主，只有 owner 持有桥；其余 tab 显示「另一标签页已连接」。避免同名注册的抢占语义暴露给用户。既有约束正好与之一致：`ClientMcpWsConnection` 按**名字**拒绝同一条连接上的重复注册（`already_registered`），不区分 session，所以一条 WS 连接本来就无法用同一个 server 名绑两个会话——要绑多个就得用不同名字。v1 不做。
6. **`alwaysLoadTools: true` 必须带上**（事实 12、13），否则 agent 想读本地文件得先猜工具名去 `tool_search`。顺带核实到仓库有一个用户可见设置 `tools.toolSearch.enabled`，其中文文案明写"启用后，MCP 工具会通过 ToolSearch 按需加载"——关掉它 MCP 工具就会全量加载。但桥不能依赖用户去关这个设置，所以 `alwaysLoadTools` 仍是正确的杠杆：它对两种设置都成立。

## 6. 工具面（v1）

server 名要短（会进每个工具名，事实 5）：`local-files` → `mcp__local-files__read_file`。

| 工具             | 参数                                         | 说明                                                                                                        |
| ---------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `list_directory` | `path`                                       | 返回条目名 + 类型 + 大小 + mtime；有界（默认 500 条）                                                       |
| `read_file`      | `path`, `offset?`, `limit?`                  | 文本读取；字节上限；二进制拒绝并说明                                                                        |
| `write_file`     | `path`, `content`                            | 整文件覆盖（v1 不做 `edit_file` 的字符串匹配，避开唯一匹配/CRLF/编码边界）                                  |
| `search_files`   | `pattern`, `path?`, `maxFiles?`, `maxBytes?` | 有界遍历 + 子串匹配。实测遍历本身很快（事实 14），成本在逐文件取内容，所以必须有 `maxFiles`/`maxBytes` 上限 |

不提供 `delete`（§0）。工具描述里必须写明**这些文件在用户本地机器上，不是 daemon workspace**，避免模型把两套文件系统搞混。

浏览器侧 MCP server 手写 `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `prompts/list` / `resources/list`（后两个返回空结果即可，事实 2 显示子进程会探测），并且**必须幂等**——一次注册会有 N+1 轮握手（事实 9）。

## 7. 生命周期

1. **连接**：用户点「连接本地目录」→ frame/secure-context 自检 → `showDirectoryPicker` → Web Locks 抢主 → 懒开 `/acp` WS（bearer 子协议）→ ACP `initialize`。
2. **注册**：`mcp_register {server, sessionId}`；遇 `register_failed` 则重新预热（`POST /workspace/acp/preheat`）后重试（事实 8）。客户端必须有耐心，daemon 自己在 CDP 路径上重试 20×250ms（`acp-http/index.ts:813-826`）。
3. **使用**：工具调用经现有审批流。
4. **断开**：WS close → daemon 自动摘除 server（事实 7）。UI 要能从 `mcp_server_removed` 事件感知（既有 `mcpVersion` signal 已覆盖，无需新事件管道）。
5. **刷新恢复**：IndexedDB 取回句柄 → `queryPermission` → `granted` 静默重连；`prompt` 要求一次点击（事实 15、17）。
6. **UI 状态机**：`未连接 / 授权中 / 已连接(绑定会话 X, 根目录 Y) / 已断开 / 不可用(原因)`。

## 8. 实施切片

**片3 — daemon 侧最小改动（已完成，未提交）**

改动落在两个文件，`ClientMcpSenderRegistry` 本身**一行未动**（`setSession`/`ownsSession`/`deleteSession`/`lookup` 全部是既有能力）：

- `acp-http/client-mcp-ws.ts`：`McpRegisterFrame` 增加可选 `sessionId`；新增 `ClientMcpServerScope`；`ClientMcpServerProvider` 的两个方法带上可选 scope；`ClientMcpWsConnection` 用 `serverScopes` map 记住每个 server 的注册 scope，使 `mcp_unregister` 与 WS close 的 `dispose()` 都按**原 scope** 拆除（少了 sessionId 就会漏拆会话侧那份、留下死 transport）。非法 `sessionId` 返回结构化 `invalid_session_id`。
- `acp-http/client-mcp-sender-registry.ts`：`ClientMcpBridge` 增加 `addSessionRuntimeMcpServer`/`removeSessionRuntimeMcpServer`；新增 `registerSessionScopedClientMcpServer`，在 `scope.sessionId` 存在时接管，镜像 `channel-worker-group.ts:258-330` 的生产序列。workspace 路径逐字未改。

两处**刻意的不对称**，评审时不要当成疏漏：

- 会话路径在 `skipped` 时也会调 `removeSessionRuntimeMcpServer`（owner-scoped catch 统一兜底，桥侧幂等）；workspace 路径在 `skipped` 时不调 remove。前者照的是 channels 的生产代码，后者是既有行为，两边各有测试钉住。
- `alwaysLoadTools: true` **只加在会话路径**。workspace 路径今天没有生产客户端，顺手改它属于未被请求的行为变更。

验证：`npm run build --workspace=packages/cli` 干净；`client-mcp-sender-registry.test.ts`（16）+ `client-mcp-ws.test.ts`（8）全绿，新增 9 条覆盖会话作用域（只加到该会话、跨会话与无 session context 硬拒绝、按 scope 拆除、peer 抢占不误删、skipped/shadowed 回滚、非法 sessionId、scope 透传）；`.qwen/scripts/client-fs-spike/spike.mjs` 对真实 daemon 重跑仍 `SPIKE: PASS`，证明无 `sessionId` 的 workspace 路径无回归。

**尚未做**：`docs/developers/qwen-serve-protocol.md` 里没有 `mcp_register` 的帧级规范（只有 capability tag 行），所以本次没有文档同步义务；若后续要把反向通道作为公开协议，需要补帧契约一节。

**片4 — Web Shell 侧**

- **4a FSA 封装（已完成，未提交）** — `packages/web-shell/client/local-files/`：
  - `file-system-access.d.ts`：TS 的 DOM lib 缺 `showDirectoryPicker`、`FileSystemHandle.queryPermission/requestPermission`、目录异步迭代器，本地补声明（`createWritable`/`getFile` 已在 lib 里）。
  - `capabilities.ts`：运行时探测 `pickerAvailable`/`secureContext`/`frame`，产出 §4 降级矩阵要的 `blocker`。
  - `local-directory.ts`：路径安全门面。`splitRelativePath` 拒 `..`/绝对路径/盘符/反斜杠/控制字符（**不**拒字面 `%`，因为路径从不做 URL 解码）；`list`/`read`/`write`/`search` 带各自上限；错误带 `code`。
  - `directory-handle-store.ts`：IndexedDB 存句柄，**resolve 在 `tx.oncomplete` 而非 `request.onsuccess`**（提交前 ack 会在页面离开时丢掉授权）；全部方法软失败，持久化不可用只降级成"再问一次"。
  - `pick-directory.ts`：`pickDirectoryHandle` 区分 `picked`/`cancelled`/`unavailable`/`failed`（用户取消不是失败，策略拦截也不该被说成"浏览器不支持"）；`ensureReadwritePermission` 只在真实手势里才 `requestPermission`。
- **4b 浏览器内 MCP server（已完成，未提交）** — `mcp-server.ts`：手写 JSON-RPC（不引 MCP SDK 进 bundle），`initialize` 回显 protocolVersion 且幂等，`prompts/list`/`resources/list`/`resources/templates/list` 回空，4 个工具，工具描述里写明文件在**用户本机**且带上授权目录名。文件系统失败作为 `isError` 工具结果返回（模型能看到原因并自行处理），协议错误才用 JSON-RPC error（未知方法 -32601、内部错误 -32603）。
- 验证：`packages/web-shell` 下 5 个测试文件 **89 tests 全绿**，`npm run typecheck` / `eslint` / `prettier --check` 均干净。全部用注入假依赖跑在 node 环境，不需要 jsdom、不碰真实浏览器 API。
- **尚未接线**：4a/4b 目前没有任何调用方，端到端仍未验证——spike 证明的是 Node 客户端走通反向通道，浏览器里跑同一套还没做过。

**4c WS 客户端（已完成，未提交）** — `bridge-client.ts`：`LocalFilesBridge` 状态机（`idle / held-elsewhere / connecting / registering / connected / reconnecting / stopped / failed`），懒开 `/acp`、bearer 子协议（与 `TerminalPanel.tsx:38-57` 同方案，`qwen-ws` 标记 + `qwen-bearer.<b64url>`）、ACP initialize、`mcp_register {server, sessionId}`、把 `mcp_message` 帧接到 `LocalFilesMcpServer`。框架无关（不依赖 React/DOM 全局），socket 与 lock manager 都注入，整个状态机跑在 node 测试里。

四条行为是实测驱动的，不是猜的：

- **注册重试**：`register_failed` → `rewarm()`（4d 接到 `POST /workspace/acp/preheat`）→ 重发，预算 6 次（事实 8）。
- **重连归零条件**：`reconnectAttempts` 只在 `mcp_registered`（真正可用）后归零，**不在 `open` 后**。否则一个"接受连接但立刻断开"的 daemon 会永远以基础间隔重试，`maxReconnectAttempts` 永远达不到。`registerAttempts` 同理按"连续失败"计。
- **socket 回收**：initialize 超时走 `recycleSocket`——先摘引用再 `close()`，这样 close 事件不会被当成第二次掉线，也不会把还开着的旧 socket 泄漏在新连接底下。
- **失败态不被覆盖**：`teardown()` 不改状态；否则 `fail()` 设完原因再调 `stop()` 会把 `failed` 覆盖成 `stopped`，UI 只显示"已停止"而丢掉原因。

另外：Web Locks（`navigator.locks`，TS lib.dom 已有类型）做多 tab 选主，`ifAvailable` 拿不到锁就报 `held-elsewhere` 且不开 socket；`start()` 对已在运行的实例是 no-op（React effect 重跑会撞上）；只应答发给自己的 `server` 的 RPC 帧。

验证：6 个测试文件 **118 tests 全绿**，`typecheck` / `eslint` / `prettier --check` 干净。

**4d UI 与接线（已完成，未提交）**

- `local-files/useLocalFilesBridge.ts`：React 接线。挂载时探测上下文 → 从 IndexedDB 取回句柄 → `queryPermission` 为 `granted` 就**静默重连**（片0 实测 Chrome 151 是 granted），为 `prompt` 就落到 `needs-gesture` 等一次真实点击（`requestPermission()` 消耗 activation，effect 里做不到）。`sessionId` 变化即重绑。所有每次渲染会变的选项都经 `optionsRef` 读取，使回调身份稳定——否则调用方内联的 `rewarm` 会让挂载 effect 每次渲染都重跑。
- `components/LocalFilesControl.tsx`：StatusBar 里的图标按钮 + popover。popover 主体拆成 props 驱动的 `LocalFilesPanel`（无 hook、无 portal），所以 §4 降级矩阵的每一态都能在 jsdom 里直接断言，不需要 Radix portal 或 daemon provider。
- 入口只加一行：`StatusBar.tsx` 的 `{connected && !compact && <LocalFilesControl />}`。StatusBar 仅在 App.tsx 渲染，而 App 已被 `DaemonWorkspaceProvider` 包裹，provider 不是新依赖。
- i18n：`localFiles.*` 27 键 × en/zh。`Messages` 是 `Record<string, MessageValue>`，**en/zh 不做穷尽性检查**，漏一个中文键只会静默回落成裸 key——所以有一条测试遍历全部 12 种状态用 `zh-CN` 渲染并断言不出现 `localFiles.`。
- 生命周期竞态（自检发现并修，各有测试钉住）：
  - 卸载或 disconnect 时若有 `connect()` 正在等原生选择框（可能几十秒），它回来后仍会 `startBridge()` → **一个没人能停掉的桥带着目录授权活在后台**。用 generation 计数在每个 await 之后校验。
  - 双击 connect 会开两个原生对话框并竞态两个桥 → in-flight 守卫，picker 只开一次。
- 验证：web-shell 8 个测试文件 **155 tests** 全绿；`App.test.tsx` **674 tests** 全绿（覆盖 StatusBar 改动）；`typecheck` / `eslint` / `prettier --check` 干净。

**关于 `onGrant`**：hook 一度有 `onGrant` 回调，想在连接成功时发一条会话内通知。但侧边栏拿不到 toast 上下文，而注入 `DaemonSessionNotice` 是更大的改动，于是按"不留死开关"的原则把该选项删了（声明了却没有任何调用方设置它）。popover 内的状态显示是用户侧的反馈。

**更正本文档早先的一处错误判断**：这里曾写"只有用户知道本地目录连上了，模型不知道，要等第一次调用工具才发现"。**这是错的**，核实之后该顾虑应当删掉——模型侧的告知已有现成机制，而且本设计已经在喂它：

- `mcp-server.ts` 的 `initialize` 返回带 `instructions`（"…directory is on the user's own machine, reachable only through these tools"）。
- 子进程侧 `McpClient` 存下它（`packages/core/src/tools/mcp-client.ts:609`，accessor 在 `888`）→ `McpClientManager.getServerInstructions()` 汇总（`mcp-client-manager.ts:1959-1968`）→ `ToolRegistry` 转出（`tool-registry.ts:1001`）。
- `client.ts:1117-1119` 在工具刷新时调 `queueMcpServerInstructionsReminder(toolRegistry.getMcpServerInstructions())`；该方法按 `serverName + 文本` 做增量 diff（`client.ts:1824-1841`），server 消失时撤掉已公告记录，所以断开再连会重新公告；`drainPendingMcpServerInstructionsReminder()`（`client.ts:1843-1860`）把它作为 `role:'user'` 消息注入历史。
- 另外 `alwaysLoadTools: true` 让这 4 个工具**不进 deferred/tool_search 桶**，直接出现在 `toolRegistry.getFunctionDeclarations()` → `setTools()` 的工具 schema 里，每个描述都写明文件在用户本机并带上授权目录名。（注意 `queueAddedMcpToolsReminder` 的入参是 `deferredTools`，所以"MCP 工具新增"那条 reminder 不覆盖本桥——但工具本来就在 schema 里，这比 reminder 更强。）

**组合验收已跑通（`.qwen/scripts/client-fs-spike/accept-local-files.mjs`，`ACCEPTANCE: PASS`）**：真 HOME + 真模型凭证 + 真 Chrome + 真 FSA 授权，无任何文件系统桩。判据是一个只存在于 canary 文件里的随机 token（不在 prompt 中、不可猜测）出现在会话 SSE 流里——它只可能经"模型调桥工具 → 浏览器用 FSA 读盘 → 字节回传"这条路到达。实测流从 ~37k 心跳基线涨到 61,369 字符。

daemon 日志给出独立佐证的时间线：`16:42:50` 浏览器 attach 会话（`SSE stream opened`）→ `16:44:48` `bridge sendPrompt` + `POST /session/:id/prompt 202` → `16:44:54` `prompt turn completed`（约 6 秒一轮）→ `16:44:54` `DELETE /session/:id 204`（清理成功）。

**这同时回答了上面那条原先标注"仍未核实"的问题**：会话是在桥连接**之前**就创建的，模型仍然发现并调用了桥工具——所以会话中途的 runtime MCP 注册确实会刷新该会话的工具集，`alwaysLoadTools: true` 让工具无需 `tool_search` 即可被直接调用。仍未单独取证的是 `instructions` 那条 reminder 是否也在同一刻注入（验收没有留存流文本），但它只是锦上添花：工具本身已在 schema 里。

**一个 harness 缺陷（已修，非功能问题）**：验收脚本原先用 `mcp__local-files__\w+` 扫工具名作为辅助证据，真实 PASS 的那一轮**一次都没匹配上**——ACP 的 `session_update` 事件带的是工具显示标题，不是内部全名。判据本身（token）不受影响，正则已放宽并加注说明。

4d 必须知道的一条：**会话级注册不发工作区事件**。`addSessionRuntimeMcpServer` 的契约明写 "does not mutate workspace bootstrap state, affect sibling sessions, **or emit a workspace event**"（`packages/acp-bridge/src/bridgeTypes.ts:2231-2242`），所以 `mcp_server_added` → `mcpVersion` signal 那条既有刷新链路**不会**为这个桥触发。UI 状态只能由 `LocalFilesBridge.onState` 自己驱动，不能等 MCP 事件；反过来，MCP 管理面板也不会因为这个桥而出现新条目（它按 `configOrigin` 过滤，而会话级 server 根本不在工作区列表里）。

**端到端验证（真 daemon + Vite dev 源码 + 真 Chromium）抓到两个只有贯通才会暴露的问题**，674 个 App 单测与 551 个侧边栏单测都没有：

1. **`/acp` 不在 Vite dev 代理表里**（`/voice/stream`、`/terminal` 都在且都带 `ws: true`）。生产环境页面源就是 daemon，`/acp` 同源所以没事；但 dev 模式下桥会连到 Vite 而不是 daemon，永久停在 `connecting`。已按既有模式补上 `'^/acp/?$': { ...daemonProxy, ws: true }`（精确路径正则，避免前缀遮蔽客户端源模块，理由同 `/voice/stream` 的注释）。
2. **StatusBar 是错误的插入点。** `<StatusBar>` 全仓只有一个渲染点（`App.tsx:15953`），且是 `CustomFooter = renderFooter` 这个**宿主 render prop 缺席时的 fallback**；那里 `compact={true}` 是硬编码的。于是 StatusBar 里所有 `!compact` 的内容——设置齿轮、mode 指示器、快捷键——在真实应用里都不渲染。入口已改到**侧边栏底部**（daemon 状态按钮旁），并按既有约定加了可被宿主裁剪的 `footerItems` 项 `'localFiles'`（类型联合 + `DEFAULT_FOOTER_ITEMS`）。触发器改成朴素 `<button>` 且 `triggerClassName` **必填**，由侧边栏传自己的 `styles.collapseButton`，避免发明第二套按钮样式。

**端到端已贯通（`.qwen/scripts/client-fs-spike/e2e-browser.mjs`，`E2E: PASS`）**：真 daemon + Vite dev（直接服务 TS 源码，无需构建 web-shell）+ 真 Chromium。从侧边栏点进去 → popover → 「Connect a directory…」→ 页面开真实 `/acp` WebSocket（穿过 dev 代理）→ ACP initialize → `mcp_register {server:'local-files', sessionId}` → **真实 ACP 子进程**对页面托管的 server 跑完 MCP 发现 → UI 显示 `Connected` + `4 tools` → Disconnect 回到 `Not connected`。IndexedDB 用的是 Chromium 真实的实现，不是假件。

只有一处是假的：`window.showDirectoryPicker` 被替换成最小假句柄——原生目录对话框无法自动化。因此**已证明**的是"浏览器 bundle → 真实反向通道 → 会话级注册 → 子进程发现"这条链；**仍未证明**的是"一次真实 `tools/call` 打到真实 FSA 句柄上"。那一环由两侧分别覆盖：daemon 侧 `client-mcp-ws.test.ts:235`（register → tools/list → tools/call over WS），浏览器侧 `local-directory.test.ts` + `mcp-server.test.ts`（真实 FSA 行为另由片0 探针在真 Chrome 里验过）。**组合起来没跑过**，需要一次带模型的验收（见 §10）。

顺带纠正一个假设：`/capabilities` 在单 workspace 配置下**没有 `workspaces` 数组**（实测 keys：`v, protocolVersions, qwenCodeVersion, mode, features, modelServices, workspaceCwd, transports, policy, limits`）；会话深链用裸 `/session/<id>` 即可，`?context=standalone` 会去查独立会话注册表并 404。

## 9. 回退

片3 不通 → 退回 workspace 级注册不可接受（§5.1），只能放弃该特性或改做只读上传快照（`<input webkitdirectory>`，跨浏览器、非安全上下文可用，但只是"拷进来 + 结果拿回去"，不是实时读写）。
片4 的 FSA 在真实部署源上不可用 → 按 §4 降级矩阵处理，不影响已落地的 daemon 侧能力。

## 10. 验证

- `.qwen/scripts/client-fs-spike/spike.mjs` 保留为回归（对真实 daemon，零源码改动，`SPIKE: PASS` 为门槛）。
- E2E 测试计划写入 `.qwen/e2e-tests/`：顶层标签页连接 → agent 读写本地文件 → 刷新静默恢复 → 关 tab 自动摘除 → 跨会话调用被拒 → 侧边栏 iframe 降级为「新标签页打开」。

## 11. 未决

1. 绑定会话的选择规则：连接时绑定当前活动会话（v1 倾向），分屏下是否允许多会话各绑一份。
2. server 名是否带会话后缀（`local-files` vs `local-files-<sid8>`）；`setSession` 已按 session 维度区分，固定名即可，除非允许一个浏览器同时绑多个会话。
3. 非安全上下文是否要做只读上传快照兜底（§9），还是只给出"改用 https / SSH 隧道"的引导。
