# 验证结果：远程会话经 launchd 中继使用本地桌面机（PR #11799）

## 最终候选复核（2026-09-25）

核心 Linux Serve → Mac 桌面流程通过。下方是按时间倒序保留的执行记录，历史“待完成/尚未提交”描述反映当时状态，不覆盖后来的复验结果。HTTP + IP 接入引导属于独立跟进 #12696。

独立测试工程师在 Node 22.23.2 串行复跑当前候选：CLI registry/WebSocket 35、静态 CSP 20、Serve capability 开关 2、desktop-relay 47、Web Shell client/panel/Vite 36，合计 140/140 通过（13 个文件，所有命令 exit 0）；`git diff --check` 通过。已部署候选的全量 build/typecheck/bundle 通过。该结论不替代推送后新提交的 CI。

未覆盖范围仍为连续 GUI 输入取消、Safari、跨机 SSH raw MCP、全新 Mac 安装/TCC；公开 `@latest` 安装路径仍需包含本实现的包发布。原生授权没有截图，只有用户明确确认和实际 connected/工具执行证据。

公开报告及 5 张已检查隐私信息的截图：[PR 测试报告评论](https://github.com/QwenLM/qwen-code/pull/11799#issuecomment-5832844845)。截图包含未连接/已连接面板、实际桌面 MCP 结果、测试文档及断开后拒绝调用。原生授权框补拍因独立截图进程未获屏幕录制权限失败，未上传该图，也未制作替代图；用户确认 Allow 后已复核 connected，补拍结束再次断开。评论明确区分历史调用结果与后来补拍的连接面板，并注明未提交候选补丁、未覆盖范围，不作为 PR HEAD 的完整验收结论。

## 2026-09-25 20:06：生命周期修复后的真机补验

运行候选仍为下文 SHA256 `62f4eb07…`，不是尚未包含这些修复的远端 PR HEAD。

- 用户明确确认看到了原生框并点击 Allow；中继返回 connected。此前仅凭“等待确认”或窗口元数据推断用户可见是不成立的。
- 切到第二会话显示“被其他会话使用中”，再回原会话调用 desktop-node-repl 成功，返回 `darwin` 与切换前写入的 `relay-switch-check` 标记，未重新连接或重设标记。先前的会话切换注册丢失未复现。
- 本地仅准备独立测试文档作为 fixture，不计为远程控制证据。随后远端会话通过 desktop-node-repl / Computer Use 读取并修改 Mac 文档：全选、输入后观察到 `Hello from remote Linux - Mac Computer Use verified`。输入请求是小写 hello，实际首字母大写；不宣称逐字节输入一致。首次 cell 返回 running，之后通过 node_repl_wait 收集完成，没有盲目重发输入。
- 中文系统下 `getApp('TextEdit')` 未匹配到应用；改用 `com.apple.TextEdit` 成功。单凭 app_not_running 断言应用进程不存在是不准确的。
- 独立测试工程师重跑当前源代码：node-repl desktop-relay 47/47，CLI sender registry / WebSocket 35/35，合计 82/82。已撤回的 session/resume 方案未混入本次产物。

20:18 收尾结果：

- 截图通过：仅返回测试文档内容区，排除标题栏/边缘并 flatten 白底。前两张从 y=120 裁剪的图均为空白；改为 y=60 后清晰显示 `REMOTE LINUX TO MAC VERIFIED`。独立从该会话原始 tool_result 提取并目检 636×352 PNG，SHA256 为 `ed3e0831810ff2fb6b9d44fd1315ec3aaf7b1419d870cbf129674cdf8e6c3a76`。空白源于裁掉文字，模型此前归因 TCC 的结论已被否定；没有要求用户修改系统权限，没有发布原图或桌面背景。
- 点击真实面板“断开”后 UI 显示未连接，Mac relay 为 stopped；tool_search 返回零命中，随后按旧精确工具名调用返回 `Tool "mcp__desktop-node-repl__node_repl" not found in registry.`，没有重新授权或静默重连。
- 本轮结论：**Linux Serve → 用户原生授权 → Mac Computer Use 读写与裁剪截图 → 会话切换保持 → 主动断开撤销**这条核心场景通过。测试文档保留在本地临时目录，未用 GUI 保存修改；测试会话页面保留供查看，桌面连接已断开。
- 限制：连续 GUI 输入中的取消仍未覆盖（已覆盖非 GUI cell 取消后超过 30 秒继续调用）；Safari、跨机 SSH raw MCP 路径未完整验收。不能据此宣布所有平台或 PR 发布门禁全部通过，当前补丁也尚未提交/推送。

## 2026-09-25：真实 Linux → Mac 连接入口补验

基于 `0ae4ff5660` 的后续工作树修复，尚未完成完整桌面验收。Linux 上运行 Mac 构建并传输的 bundle，复用 Linux 已安装的原生依赖，没有在服务器构建或覆盖既有安装。Mac 通过 SSH local-forward 访问 Linux Serve；本地转发端口不是另一台本地 Serve。

- 真实 Linux Serve 健康检查和模型仅回复 OK 的对话通过。
- 浏览器日志明确显示 `/status` 被页面 `connect-src` 拦截。这推翻了下节“探测被浏览器权限阻止”的推断：权限查询为 `prompt` 不等于请求已弹出授权框。
- 修复后，仅 `clientMcpOverWs === true` 的生产页面及 SPA fallback 放行固定地址 `http://127.0.0.1:47821`；默认 CSP 不变，Vite 使用与生产一致的环境变量语义。只有明确 `denied` 才提示浏览器权限，其他探测失败不再声称用户尚未授权。
- 全量 build、typecheck、bundle 与相关文件 lint 通过；生产路由开关 2 项、静态路由 20 项、Web Shell/Vite 35 项测试通过。重新部署的 `dist/cli.js` 两端 SHA256 均为 `942a5662eb33408fb814f5bb04caa560ce37ef46e1f92987d5053e2498835326`。
- 同一浏览器页面无需修改权限即检测到 Mac 中继，状态为“未连接”。点击“连接这台电脑”后进入“等待确认”；Mac 窗口列表确认对应 `osascript` 进程拥有可见窗口。未截图、未自动点击授权。随后确认框进程结束，`/status` 没有 active 连接；不能仅据此区分超时与用户拒绝。

解锁后补验（19:08–19:13）：用户回复“好了”后，Mac 锁屏状态为 false，中继 `/status` 返回该 Linux 会话的 `connected`。同一 Web Shell 会话的远端 shell 返回 `Linux`；`mcp__desktop-node-repl__node_repl` 执行 `nodeRepl.write((await import('node:os')).platform())` 返回 `darwin`，已展开工具结果核对，不仅依赖模型总结。首次使用 `process.platform` 的探针因隔离内核没有 `process` 失败，不能计为通过；随后受支持的 `node:os` 探针通过。未读取凭据或截取屏幕。

- Computer Use SDK 初始化成功，`getPlatform()` 的实际工具结果为 `macos`。TextEdit 返回 `No open application window.`；新建快捷键被 SDK 以 `app_window_unavailable` 拒绝，随后再观察仍无窗口。没有重复发送、输入文字或返回截图，已请用户准备空白测试文档。
- 真实 Web Shell 取消补验：桌面 cell 设置 `cancelProbe.finished=false` 后等待 60 秒，在执行中点击停止。19:19:58 页面确认回合取消，19:20:32 中继仍为 connected，之后允许新的只读调用，实际结果为 `{"platform":"darwin","probe":{"finished":false},"computerStillPresent":true}`。证明跨过 30 秒关联超时后可继续调用且原内核状态保留；本项是非 GUI cell，不冒称桌面连续输入取消已验收。
- 第二会话面板显示“被其他会话使用中”；该会话实际 `tool_search` 返回 `No tools found matching 'desktop-node-repl'`，没有发起连接或替换原会话。返回原会话后面板仍为“已连接”。这是正常会话工具隔离证据，不是恶意跨会话协议攻击测试。
- 随后原会话调用却返回 `Tool not found in registry`，因此**切换再返回不通过**。代码核实：页面切换会 detach 旧会话；没有其他客户端/订阅时，live session 被关闭，恢复会话不继承旧的 session-scoped 注册，而 relay 的 WS 尚在。修复使用服务端现有 EventBus 订阅保活并跟踪结束，订阅由 sender owner 管理，注销/替换/断开时释放，不新增权限投票者。针对真实 EventBus 的生命周期、替换与失败回滚回归及既有 WS 测试 35 项通过；修复后的跨机复验待完成。曾尝试的 `session/resume` 方案因 consensus 投票副作用已撤回，未部署。
- 生命周期修复经独立复核、聚焦 lint、全量 build/typecheck/bundle 后已部署到原 Linux 隔离目录。新 bundle 两端 SHA256 为 `62f4eb078eea1958c777f7d0e53cd4fb0353138cb3c01eaf1a2b5610a4c8889c`。停止旧 Serve 后 Mac relay 返回 `stopped / connection closed (code 1000)`；新 Serve 健康检查成功后 relay 仍为 stopped，没有静默重连。此时只读检查显示 Mac 再次锁屏，未反复触发原生确认框；解锁后的重新授权与修复后真机复验待完成。
- 本轮重新完成全量 build/typecheck（含 integration），以及中继聚焦 20 项、Web Shell/Vite 36 项、静态路由 20 项测试，均通过。

**仍未验收**：GUI 操作与截图、连续桌面操作的取消、断开及重启。连接、平台探针、非 GUI 取消恢复和正常会话隔离通过不等于这些项目已通过。Safari 和 SSH raw MCP 路径也尚无完整验收证据。

### 原生框不可见的后续排查

用户报告仍看不到确认框。只读窗口元数据检查发现：确认框位于主屏幕范围内，但系统前台为 `loginwindow`；`CGSessionCopyCurrentDictionary` 返回 `CGSSessionScreenIsLocked=1`、onConsole=1、loginDone=1。当前 Mac 处于锁屏状态，窗口存在不能证明用户可见，也不能据此认定激活代码失败。没有尝试解锁、绕过锁屏或截取屏幕。

保留弹框前标准 `activate` 的一行改动，删除排查中临时加入的 AppKit 激活策略代码，避免把锁屏问题转成不必要的实现复杂度。参数测试同时锁定默认/取消按钮 Deny、60 秒对话框超时和 70 秒进程上限；中继 47 项测试通过。解锁后连接已成功，见上方补验；没有把窗口列表的可见标记当成人眼看到弹框的证据。

## 2026-09-25：Mac 补验（尚未完成跨机验收）

验证提交：`04d5d90fcc`，Mac 上重新打包并安装本分支的中继，使用 `@qwen-code/cua-sdk@0.20.11`。以下结果不替代后文 2026-09-23 的 Linux 记录。

- 冻结锁文件安装、全量 build/bundle、lint、typecheck 均通过；中继测试 45/45、Web Shell 入口与权限测试 23/23、daemon 开关到 capability 的聚焦测试 9/9 通过。
- 真实 launchd 连续五次 `/status` 均返回 200，耗时分别为 0.215、0.195、0.156、0.144、0.152 秒，未观察到此前担心的 10 秒节流。空闲时由 launchd 监听，没有常驻中继进程。
- 真实 HTTP 边界：正常状态 200，外来 Host 421，无 Origin 的连接请求 403，预检 204 并包含 CORS/PNA 响应头。这里只验证了不需要授权的请求。
- 真实 launchd 的 raw MCP 路径：通过 TCP socket 完成 `initialize` 和 `tools/list`，返回 node-repl 0.1.6 及五个工具，未发起任何 `tools/call`，因此不应触发桌面授权；这不是跨机 SSH 验收。
- 真实 Web Shell：无会话时面板显示“等待会话”；创建仅回复 OK 的验收会话后，探测被浏览器权限阻止时显示“需要浏览器权限”，不再显示安装命令。浏览器已交还用户处理本地网络授权，没有绕过权限。
- 默认入口：配置生产链与 listener 测试确认，未设 `QWEN_SERVE_CLIENT_MCP_OVER_WS` 时不广告 capability，默认 standalone sidebar 隐藏入口；宿主显式配置 `footer.items` 可选择显示。实际开启的浏览器样本带 `QWEN_SERVE_CLIENT_MCP_OVER_WS=1`，不能作为默认隐藏的浏览器证据。
- 该提交 CI 的单元测试、无 AK 集成测试通过；静态检查在运行 lint 前被 gate freshness 拦下（main 更新了 CI 配置），不是 lint 错误。已合并 main，合并后的检查另行记录，不能沿用合并前绿灯。
- 复查修复了工具选择示例：原先读取 `ALL_TOOLS.jsName`，而 Codex 工具元数据使用 `name`，两端工具同时存在时会错误回退到普通 server。改成直接优先取桌面工具、缺失时取普通工具。测试实际执行文档示例，修复前桌面优先用例失败，修复后六项 skill 测试通过，同时检查图文转发没有把图片变成文本。
- 真实 node-repl 子进程补验找到了取消后的残留请求：SDK 在取消后不发响应，中继原先一直保留 pending。再次复用相同请求 ID 时取消被当成歧义丢弃，2 秒任务实测运行 2007 ms 到完成。修复后转发取消即清理请求、结束等待且不发送响应；首次和再次复用 ID 的请求都正常取消，pending 均为 0，后续调用成功且原 kernel 变量保留。两次探测分别在 1302/1305 ms 进行（包含固定 1 秒等待，不代表准确取消延迟）。中继回归测试 46/46 通过。该补验直接连接生产中继类和真实子进程，不涉及浏览器、WebSocket、GUI 或系统授权，不替代 Web Shell 停止按钮验收。
- 继续核对远端消费者后，补齐取消的外层响应：ACP 中继以 `-32800` 结束原 frame，防止 registrar 在 30 秒后因等待无回复而判定传输失败；raw MCP 仍不回包，取消通知本身也不回包。同时修复 SDK control transport：通知的合成 ack、已经取消请求的迟到结果/错误，不再交给已移除响应处理器的 MCP Client。真实 SDK 测试修复前会报 unknown message ID，修复后通过；既有 registrar 和协议协商测试也通过。此处只改一个共享传输点，没有扩展 daemon API 或注册协议。中继测试增至 47/47。
- 生产组件闭环补验通过：真实 SDK Client → SdkControlClientTransport → ClientMcpRegistrar → AcpRelay → McpChildRelay → 真实 node-repl 子进程。AbortSignal 取消后，302 ms 时观察到取消回复，daemon 和 child pending 均为 0；1 秒后调用成功、kernel 变量保留；再等待跨过默认 30 秒超时窗口（31 秒），Client.onerror 仍为 0，再次调用成功。线缆使用进程内连接，因此证明的是组件协议闭环，**不是跨机 WebSocket、浏览器或 GUI 验收**。
- 合并 main `99fd76553e` 并完成上述修复后，重新执行全量 build、typecheck（含 integration）、bundle 和 lint，全部通过；相关 core 23 项、中继 47 项、Web Shell 23 项测试通过。初次并行构建/检查曾因 dist/coverage 产物变化报错，后续稳定构建后的完整检查已重跑通过；不把失败轮次计为通过。最新 CI 需以推送后的检查结果为准。

**仍未验收**：真实 Linux Serve → 本机 Mac 的反向通道、原生 Allow/Deny、模型实际调用桌面工具、截图、Web Shell 停止对话、跨会话隔离、断连与重启，以及 Safari。当前 Mac 没有已配置的目标 Linux SSH 主机，需提供 SSH 地址或可访问的 Serve URL；浏览器本地网络授权仍需用户本人操作。不能据此宣布完整场景可交付。

---

> 执行时间：2026-09-23。执行机器：Linux 5.10 x86_64 开发服务器（主机名已隐去），4 核 / 15 GB，Node v24.19.0，无图形界面。
> 分支：`docs/remote-computer-use-plan` @ `7c2359015b`。
> 一句话结论：**这台机器上没有 Mac，A、B.5、C、D 的 macOS 部分无法执行**；能做的部分是"用等价的 socket 激活真跑中继自己的 HTTP 面 + 静态核对取消链路"，B.1–B.4 与 HTTP 边界全部符合预期，另外发现 2 个新问题（§4）。

## 1. 为什么不是完整的真机验证

- 本机是无 GUI 的 Linux 开发服务器，`~/.ssh/config` 为空，`known_hosts` 里只有一台内网主机（地址已隐去），`ssh` 过去是 `Permission denied (publickey,password,keyboard-interactive)`。没有可达的 macOS。
- 因此这些必须留在 Mac 上：launchd 本身（A 节）、`osascript` 对话框（B.5、C.2）、TCC 授权（C.3）、Chrome/Safari 的本地网络访问（C.1、C.8）、真实会话与模型（C.3–C.7）、SSH `RemoteForward`（D 节）。
- 按交接文档 §2 的约定，本机不跑 build / typecheck / 测试，所以 `packages/node-repl/dist` 不存在，任何需要拉起 node_repl 子进程的路径（C.3、D）在这里也跑不了。

## 2. 方法：不构建也能跑生产代码

- 用 Node 24 的 `--experimental-transform-types` 直接执行仓库里的 TS 源文件，配一个把 `./x.js` 解析到 `./x.ts` 的 `module.registerHooks` resolve hook。跑的是 `packages/node-repl/src/desktop-relay/runtime.ts` 里的 `runAgent()` 本体——生产接线，一行源码都没改。
  - 顺带一条环境信息：strip-only 模式（Node 默认）跑不起来，`mcp-child-relay.ts:72` 的构造器参数属性会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，必须用 transform 模式。这是本机跑法的限制，与 PR 无关（`tsc` 构建正常）。
- `ws` 用 8.21.3（满足 `package.json` 的 `^8.18.0`），软链到 worktree 的 `node_modules/ws`（`node_modules` 在 `.gitignore` 里，不进提交）。
- launchd 用 `inetd.mjs` 等价模拟：父进程持有 `127.0.0.1:47821` 的监听，每接受一个连接就 spawn 一个子进程，把这条连接同时作为子进程的 fd 0 和 fd 1（对应 plist 的 `inetdCompatibility` + `Wait=false`），stderr 重定向到 `agent.log`（对应 `StandardErrorPath`），父进程随后 close 自己那份 fd——和 launchd 的行为一致。
- 与真机的差异，读结果时请记住：没有 launchd（因此也没有它的节流，见发现 2）、没有 macOS 对话框、没有 TCC、没有浏览器。node_repl 子进程用真实的 `spawnNodeRepl()` 拉起，但因缺 `dist/index.js` 而立刻失败。

## 3. 实测结果

### 3.1 B 节的 HTTP 面（真实 fd-0 socket，每请求一个进程）

- B.1 `GET /status`（`Host: 127.0.0.1:47821` + `Origin: https://example.com`）→ **200**，body `{"ok":true,"version":"0.1.6"}`，耗时 0.066 s。响应头齐全：`access-control-allow-origin` 回显 Origin、`access-control-allow-methods: GET, POST, OPTIONS`、`access-control-allow-headers: content-type`、`access-control-allow-private-network: true`、`access-control-max-age: 600`、`vary: Origin`、`cache-control: no-store`、`connection: close`。无 `active` 字段（没有记录，符合"只有发起方看得到连接详情"）。
- B.1 变体：不带 `Origin` 的 `GET /status` → 200，同样只有 `ok`/`version`，耗时 0.064 s。
- B.2 `Host: evil.example:47821` → **421** `{"ok":false,"code":"bad_host"}`，0.066 s。
- B.3 `POST /connect` 无 `Origin` → **403** `{"ok":false,"code":"origin_required","message":"Only a web page can ask for this computer."}`，0.065 s，`agent.log` 里没有任何 osascript 痕迹 ⇒ 确实没走到对话框。
- B.4 `OPTIONS /connect` 带 `Origin` → **204**，含 `access-control-allow-origin` 与 `access-control-allow-private-network: true`，`content-length: 0`，0.068 s。
- B.5 `POST /connect` 带 `Origin` → **403** `{"ok":false,"code":"denied"}`，0.072 s。原因是本机没有 `/usr/bin/osascript`（见发现 1）；**对话框本身未验证**。
- 额外：`POST /disconnect`（无连接）→ 409 `not_connected`；未知路径 → 404 `not_found`；body 不是 JSON → 400 `body is not JSON`；`daemonUrl` 用 `file:///etc/passwd` → 400 `daemonUrl must be http or https`。
- 11 个连接 = 11 个子进程，全部 `exit code 0`，`agent.log` 除 Node 的实验特性警告外没有任何报错。**没有任何一次出现响应被截断或客户端挂住**。

### 3.2 curl 表达不了的 HTTP 边界

- 请求行与头分成两个 TCP 段到达（间隔 200 ms）→ 200，207 ms ⇒ `parseHttpRequest` 的 `incomplete` 分支在真实 socket 上工作正常。
- body 在头之后单独到达 → 正常解析并进入 `/connect` 逻辑（返回 403 denied 是 osascript 缺失所致）。
- 头块 > 64 KiB → 400 `request too large`。
- `Transfer-Encoding: chunked` → 400 `chunked bodies are not supported`。
- 首字节是 `{` → 进入 raw JSON-RPC 分支，本机因缺 `packages/node-repl/dist/index.js` 立即关闭连接，`agent.log` 记 `Error: Cannot find module .../packages/node-repl/src/index.js`。⇒ **D 节必须在构建过的机器上跑**，这里的失败与代码无关。
- 非 HTTP 垃圾字节：≥ 8 字节或含 `\n` → 立即关闭、无响应；< 8 字节且不含 `\n` → 挂到 10 s 读超时才关（`serveConnection` 的设计如此，不是缺陷）。
- 空闲连接 → **10076 ms** 关闭，进程随之退出 ⇒ 10 s 读超时生效，没有留下常驻进程。
- `malformed request line`（`WAT / HTTP/9`）→ 400 `malformed request line`。

### 3.3 取消链路（C.3 的前提）——静态核对，逐段有代码依据

1. `packages/core/src/tools/mcp-tool.ts:605-616`：turn 的 `signal` → `parentAbortController` → `combinedSignal`；`:675` 把它作为 `{ signal: combinedSignal }` 传给 `client.callTool(...)`。
2. `@modelcontextprotocol/sdk@1.30.0`（仓库 pin `^1.30.0`）`dist/esm/shared/protocol.js:669-686`：`options.signal` 的 `abort` 监听 → `cancel(reason)` → `this._transport.send({ jsonrpc:'2.0', method:'notifications/cancelled', params:{ requestId: messageId, reason } })`。
3. `packages/core/src/tools/client-mcp-registrar.ts:171-197`：非 request（没有 JSON-RPC `id`）走 fire-and-forget 分支，**仍然 `sendFrame({ id:'cmcp-N', server, payload })`**，并用合成 ack 立刻解决调用方的 `await` ⇒ 通知会作为帧下发，不会挂住握手。
4. `packages/cli/src/serve/acp-http/client-mcp-ws.ts:160-172`：`ClientMcpRegistrar.sendFrame` 直接映射成 `{ type:'mcp_message', id, server, payload }` 推给 WS。
5. 本 PR `acp-relay.ts` 的 `answer()`：帧 `id` 是字符串 ⇒ 通过校验 ⇒ `rpc.handle(payload)`；payload 没有 `id` ⇒ `mcp-child-relay.ts` 的 `notify()` ⇒ 命中 `notifications/cancelled` 分支 ⇒ `soleRelayId()` 改写 id 后转发给 node_repl；通知无回复，`reply === undefined` ⇒ 不会多发一帧。

⇒ **代码层面这条链是通的**，2026-09-23 的修复方向成立。仍属运行时未验证的两点：Web Shell 的"停止"是否真的 abort 到 `mcp-tool` 这一层的 signal；node_repl 收到 `notifications/cancelled` 后能否中断正在跑的 cell。这两点只能在 Mac + 真实会话上验（C.3 取消）。

后续修正：daemon 侧 `packages/core/src/tools/sdk-control-client-transport.ts` 也处理 `notifications/cancelled`；不能把源码搜索不到该字符串当作排查前提。检查线上取消链路时，应观察 `mcp_message` 帧的 `payload.method`，并确认日志实际记录了该帧。以上为当时的静态核对；后续真实 GUI 取消验收见 [PR 补充报告](https://github.com/QwenLM/qwen-code/pull/11799#issuecomment-5833265271)，不要把本节当作当前验收结论。

## 4. 本轮新发现

### 发现 1：osascript 失败与"用户点了 Deny"在外部完全无法区分，且不留一行日志（可观测性，非阻塞）

`consent.ts` 的 `runOsascript()` 把任何失败都折叠成 `code: 1`（`error.code` 是字符串 `ENOENT` 时走的就是这条），`askConsent()` 于是返回 `false`，HTTP 层返回 403 `denied`——**`agent.log` 里一个字都不写**。实测：B.5 在 72 ms 内返回 denied，日志只有 Node 的实验特性警告。

后果：macOS 上如果 osascript 缺失、被 TCC 拦住、或 LaunchAgent 的会话不允许弹框（正是 F.3 担心的那种情况），用户看到的就是"我明明没点 Deny 却被告知 denied"，而 F.3 让人去查的 `agent.log` 和 `log show` 都是空的。

建议：`askConsent()` 在 `code !== 0` 时往 stderr 写一行原因（launchd 会把它收进 `agent.log`），并把 `code`/`gave up` 一起记下来。改动很小，只影响排查体验，不改行为。

### 发现 2：launchd 的节流是 A/B 节最该先量的东西（macOS 侧风险，本机无法验证）

这套设计是"每个 HTTP 请求 spawn 一个约 60 ms 就退出的进程"（实测 0.062–0.072 s，含 Node 启动）。launchd 有一个 `ThrottleInterval`（默认 10 s）机制用于抑制快速退出的 job 被反复拉起，而 `launchd.ts` 生成的 plist **没有设置这个键**。我无法在这台机器上确认它对 `inetdCompatibility` + `Wait=false` 的每连接实例是否同样生效——我的模拟器没有节流。

所以 Mac 上第一件事建议是：**连续跑 5 次 B.1，记录每次的 `%{time_total}`**。判据：

- 5 次都在几十毫秒 ⇒ 节流不影响，A/B 节照常往下走。
- 第 2 次起变成约 10 s ⇒ 命中节流。Web Shell 会连续探测 `/status`，届时面板可能长时间停在 Not connected 甚至 Not set up，看起来像"中继坏了"，实际是 launchd 在排队。修法是给 plist 加 `ThrottleInterval`（设为 0 或 1），或改成一个常驻 agent 进程自己 `accept`（那就放弃了"平时零常驻进程"这条已定的设计，需要重新讨论）。

这条之所以值得排在最前面：它会把后面所有现象都染上"超时/卡住"的颜色，先排除掉能省很多时间。

### 发现 3（信息）：stdout 就是 socket，任何写 stdout 的东西都会插进 HTTP 响应

本机实测印证了 `runtime.ts` 的注释——Node 的 `ExperimentalWarning` 走 stderr 进了 `agent.log`，响应体干净。真实环境里同理需要留意：node 的各种 warning、被 npm 装进来的包在 import 时打印的东西，都会污染这条连接。目前没发现问题，只是 Mac 上如果看到响应解析异常，先怀疑这一点。

## 5. 对 README "本次验证可能推翻的结论" 的逐条判定

1. inetd 下 `net.Socket({ fd: 0 })` 能正常收发、浏览器能立即拿到响应 —— **部分成立**。在等价的 socket 激活下（Linux + 手工 spawn + 父进程 close 自己的副本），真实 `runAgent()` 对 11 个请求都完整写出响应并正常关闭，客户端一次都没挂住；分段到达、超大请求、chunked、垃圾字节、10 s 空闲超时的行为都与代码一致。**launchd 本身、macOS、浏览器三样都未验证**，其中 launchd 有发现 2 的节流风险。
2. 确认框从 LaunchAgent 进程弹出时可见、可点 —— **无法判断**（需要 macOS GUI）。附带的正面证据：osascript 不可用时不会挂起，72 ms 内安全地返回 denied（失败即拒绝，方向是对的），但见发现 1 的可观测性问题。
3. Chrome 与 Safari 允许安全页面访问 `http://127.0.0.1:47821` —— **无法判断**（本机无浏览器）。服务端该给的都给了：ACAO 回显 Origin、`access-control-allow-private-network: true`、`OPTIONS` 204、`cache-control: no-store`、`connection: close`；`Host` 白名单也按预期挡住外来主机名（421）。
4. TCC 授权记在 `node` 名下 —— **无法判断**（无 TCC）。
5. 模型跳过 bootstrap；截图不超过帧上限 —— **无法判断**（需要真实会话）。帧上限这一侧有代码依据：`constants.ts` 的 `MAX_RELAYED_REPLY_BYTES = 9 MiB`，`mcp-child-relay.ts` 的 `fitToFrame()` 超限时把结果换成一句模型能照做的错误提示。
6. 在 Web Shell 里停止对话能中止桌面上正在运行的 node_repl 单元 —— **代码链路成立，运行时未验证**（§3.3 给了五段代码依据；剩下的两个环节见该节末尾）。

## 6. 交给 Mac 的最小清单（按此顺序，前两步最能定性）

1. 连续 5 次 B.1 并记录 `%{time_total}`（排掉发现 2 的节流）。
2. A 节：install → `launchctl print` / `lsof` / `pgrep` / `desktop-relay status`。
3. B.2–B.5，其中 B.5 要真的点一次 Deny、再点一次 Allow。
4. C.1–C.8，C.3 的取消检查必测。
5. D 节（需要 `packages/node-repl/dist`，先 `npm run build`）。
6. E 节清理。

## 7. 复现材料

本轮的 harness 都在本机临时验证目录（个人路径已隐去），没有进仓库（它依赖本机绝对路径和临时 `node_modules`）：

- `inetd.mjs`：launchd inetd 的等价模拟（监听 + 每连接 spawn + stderr 落 agent.log）。
- `hooks.mjs`：把 `./x.js` 解析到 `./x.ts` 的 resolve hook，配合 `--experimental-transform-types` 免构建跑 TS。
- `child.mjs`：被 spawn 的那一端，调用真实的 `runAgent()`。
- `b-tests.sh` + `b-tests-output.txt`：B 节的 11 个请求与原始输出。
- `edge-probes.mjs` + `edge-probes-output.txt`：§3.2 的边界探针与原始输出。
- `cancel-probe.mjs`：想用 SDK 的内存 client/server 对动态复现"abort → `notifications/cancelled`"，本机这次没跑出输出（进程被那个故意永不 resolve 的 handler 拖住），所以 §3.3 第 2 段给的是 SDK 源码级证据而不是实测。

如果希望这些变成仓库里的长期回归，我可以把 §3.1/§3.2 改写成 `packages/node-repl/src/desktop-relay/` 下的一个 vitest 用例：真实 `net.Server` + 真实 `spawn` 走 fd 0，而不是像现有 `agent.test.ts` 那样只喂假的 `Duplex`。现有单测覆盖不到的正是"真实 socket + 每连接一进程"这一层。
