# 验证结果：远程会话经 launchd 中继使用本地桌面机（PR #11799）

> 执行时间：2026-09-23。执行机器：`vscode-sqlx011163220057.na131`，Linux 5.10 x86_64，4 核 / 15 GB，Node v24.19.0，无图形界面。
> 分支：`docs/remote-computer-use-plan` @ `7c2359015b`。
> 一句话结论：**这台机器上没有 Mac，A、B.5、C、D 的 macOS 部分无法执行**；能做的部分是"用等价的 socket 激活真跑中继自己的 HTTP 面 + 静态核对取消链路"，B.1–B.4 与 HTTP 边界全部符合预期，另外发现 2 个新问题（§4）。

## 1. 为什么不是完整的真机验证

- 本机是无 GUI 的 Linux 开发服务器，`~/.ssh/config` 为空，`known_hosts` 里只有一台 `30.220.88.69`，`ssh` 过去是 `Permission denied (publickey,password,keyboard-interactive)`。没有可达的 macOS。
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

补充一条排查手册的精确化建议：`notifications/cancelled` 这个字符串在整个仓库里**只出现在本 PR 的 `mcp-child-relay.ts` 和它的测试里**，daemon 侧源码里搜不到。所以 F.6 让人"在远端 daemon 上打开 MCP 调试日志确认 notifications/cancelled 有没有发出"时，要找的是 `mcp_message` 帧的 `payload.method`，直接在 daemon 日志里 grep 这个关键字很可能什么都搜不到而误判成"daemon 没发"。

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

本轮的 harness 都在本机 `/home/admin/jinjing/tmp/rcu-verify/`，没有进仓库（它依赖本机绝对路径和临时 `node_modules`）：

- `inetd.mjs`：launchd inetd 的等价模拟（监听 + 每连接 spawn + stderr 落 agent.log）。
- `hooks.mjs`：把 `./x.js` 解析到 `./x.ts` 的 resolve hook，配合 `--experimental-transform-types` 免构建跑 TS。
- `child.mjs`：被 spawn 的那一端，调用真实的 `runAgent()`。
- `b-tests.sh` + `b-tests-output.txt`：B 节的 11 个请求与原始输出。
- `edge-probes.mjs` + `edge-probes-output.txt`：§3.2 的边界探针与原始输出。
- `cancel-probe.mjs`：想用 SDK 的内存 client/server 对动态复现"abort → `notifications/cancelled`"，本机这次没跑出输出（进程被那个故意永不 resolve 的 handler 拖住），所以 §3.3 第 2 段给的是 SDK 源码级证据而不是实测。

如果希望这些变成仓库里的长期回归，我可以把 §3.1/§3.2 改写成 `packages/node-repl/src/desktop-relay/` 下的一个 vitest 用例：真实 `net.Server` + 真实 `spawn` 走 fd 0，而不是像现有 `agent.test.ts` 那样只喂假的 `Duplex`。现有单测覆盖不到的正是"真实 socket + 每连接一进程"这一层。
