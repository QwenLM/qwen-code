# 验证：远程会话经 launchd 中继使用本地桌面机（本轮：macOS）

> 关联：PR #11799；方案见 `docs/plans/2026-09-14-remote-computer-use-desktop-relay.md`（§6 列出了本文要回答的未验证项）；交接见 `docs/plans/2026-09-14-remote-computer-use-handoff.md`。
> 状态（2026-09-25）：真实 Linux Serve → 用户原生授权 → Mac 文稿读写与裁剪截图 → 会话切换保持 → 断开撤销的核心流程已通过，见 `results.md`。连续 GUI 输入取消、Safari、跨机 SSH raw MCP 和全新 Mac 首次安装尚未完整验收；本文未被结果明确覆盖的“预期”仍不是实测结论。HTTP + IP 接入引导另见 #12696。
> 需要：一台 Mac（Chrome，最好再有 Safari），Node 22；一台能从 Mac 用 SSH 连到的 Linux 开发机。两边都要能构建本 PR。
> 出了问题先看文末的 **F. 排查手册**。

## 0. 准备

两台机器都检出本 PR 分支并构建：

```bash
git fetch https://github.com/yiliang114/qwen-code docs/remote-computer-use-plan
git checkout -B docs/remote-computer-use-plan FETCH_HEAD
corepack pnpm install --frozen-lockfile && npm run build && npm run bundle
```

仓库已经从 npm 迁到 pnpm（`package-lock.json` 已删除），不要用 `npm ci`。脚本仍然用 `npm run` 执行。

Mac 上把中继打成 tarball（`@qwen-code/node-repl-mcp` 还没发布包含本改动的版本）：

```bash
cd packages/node-repl && npm run build && npm pack && cd -
ls packages/node-repl/qwen-code-node-repl-mcp-*.tgz
```

## A. 桌面机安装

```bash
node packages/node-repl/dist/index.js desktop-relay install \
  --package "$(ls -t "$PWD"/packages/node-repl/qwen-code-node-repl-mcp-*.tgz | head -1)"
```

预期：npm 把两个包装到 `~/.qwen/desktop-relay`；打印 “registered on 127.0.0.1:47821”。然后：

```bash
launchctl print gui/$(id -u)/com.qwencode.desktop-relay | head -20   # 预期：能看到这个 job
lsof -nP -iTCP:47821 -sTCP:LISTEN                                    # 预期：launchd 在监听
pgrep -fl desktop-relay                                              # 预期：无输出（平时零进程）
node packages/node-repl/dist/index.js desktop-relay status
```

## B. 本机安全检查（不需要开发机）

```bash
# 1. /status：任何来源都能看到已安装，但看不到连接详情
curl -s -H 'Host: 127.0.0.1:47821' -H 'Origin: https://example.com' http://127.0.0.1:47821/status
# 预期：`ok` 为 `true`，`version` 与刚打包的版本一致

# 2. 外来 Host（模拟 DNS rebinding）
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example:47821' http://127.0.0.1:47821/status
# 预期：421

# 3. 没有 Origin 的 /connect 不会弹框
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"daemonUrl":"https://h/","sessionId":"s"}' http://127.0.0.1:47821/connect
# 预期：{"ok":false,"code":"origin_required",...}，桌面上没有对话框

# 4. 预检
curl -s -i -X OPTIONS -H 'Origin: https://example.com' http://127.0.0.1:47821/connect | head -12
# 预期：204，含 access-control-allow-origin 和 access-control-allow-private-network: true

# 5. 有 Origin 的 /connect 弹框；点“Deny”
curl -s -X POST -H 'Origin: https://example.com' -H 'Content-Type: application/json' \
  -d '{"daemonUrl":"https://devbox.example/","sessionId":"s"}' http://127.0.0.1:47821/connect
# 预期：桌面上弹出“Qwen Code”对话框，写明来源、daemon 主机和“can run code on this computer”；
#       点 Deny 后返回 {"ok":false,"code":"denied"}
```

记录：每个请求的耗时（`curl -w '%{time_total}'`）——每个请求都会拉起一个新进程；对话框是否在最前面、能否点击；`~/.qwen/desktop-relay/agent.log` 里有无报错。

## C. Web Shell 路径

开发机：

```bash
QWEN_SERVE_CLIENT_MCP_OVER_WS=1 node dist/cli.js serve   # 记下端口和 token
```

Mac：`ssh -N -L 4170:127.0.0.1:<端口> devbox`，然后在 Chrome 打开 `http://localhost:4170`（回环地址是安全上下文）。

1. 新建会话。侧边栏底部点显示器图标（“Use this computer”）。预期状态：Not connected。如果显示 Browser permission required，先核对权限是否明确 denied，再由用户在站点设置中处理。权限为 prompt 不能证明弹窗已出现。如果显示 Relay not detected，记录浏览器控制台的具体错误，尤其检查 CSP 是否阻止固定中继地址；不要直接认定未安装或未授权。另起一个未设 `QWEN_SERVE_CLIENT_MCP_OVER_WS` 的普通 daemon，确认 standalone 默认不显示此入口。
2. 点 **Connect this computer**。预期：状态变为 Waiting for approval，桌面弹出确认框。点 Allow。预期：状态变为 Connecting…，随后 Connected；系统通知“is now using this computer”。
3. 在同一会话里输入（保持默认审批模式）：

   > 用 computer use 在我的 Mac 上打开“文本编辑”，新建一个不保存的测试文稿，内容写 hello from remote。不要打开已有文稿或访问私人内容。每一步操作之后都重新读取界面状态，确认结果。

   记录：模型是否执行了 bootstrap（`qwen mcp add … node-repl` 或 `npm install @qwen-code/cua-sdk`，出现就拒绝并记录）；`getPlatform()` 是否返回 `macos`；读参考文档走的是哪条路；macOS 的授权提示弹给了谁（预期是 `node`）；授权后是否需要重新连接；任务是否完成；3 次 `node_repl` 调用的耗时。

   **取消（2026-09-23 的修复，必须验证）**：再让模型跑一个持续操作屏幕的单元，例如：

   > 用 computer use 在刚才的测试文稿里每隔一秒输入一个数字，从 1 输入到 60，放在同一个 node_repl 单元里完成，yield_time_ms 设为 25000。

   （反向通道单条消息的往返超时是 30 秒，中继会把更长的 yield_time_ms 截短到 25 秒；写 60000 测到的会是帧超时而不是取消。）数字开始出现后，在 Web Shell 里点停止。预期：几秒内桌面上不再出现新数字（中继把 `notifications/cancelled` 改写 id 后转发，node_repl 中止单元）。记录停止后又多出了几个数字。如果一直输到 60，说明取消没有到达桌面，按 F.6 排查。

4. 先确认测试窗口和透明、半透明区域后面没有私人内容，再通过 desktop MCP 获取仅包含测试窗口的截图。不要默认截全屏；如接口只能截全屏，先由用户整理桌面再采集。检查图片不含账号、令牌、私人聊天或其他窗口后才展示，未经用户同意不公开上传。记录截图尺寸及是否触发大小限制。
5. 在同一 workspace 的另一个会话里打开面板。预期：In use by another session。
6. 回到原会话点 **Disconnect**。预期：状态回到 Not connected；再让模型调用 `node_repl` 时得到明确错误；`pgrep -fl desktop-relay` 无输出。
7. 再连一次后，在开发机上重启 `qwen serve`。预期：中继结束（不重连），面板显示连接已关闭。
8. 用 Safari 重复第 1–2 步，记录差异。

## D. SSH 终端路径

Mac 的 `~/.ssh/config`：

```text
Host devbox
  RemoteForward /home/<you>/.qwen/desktop-relay.sock 127.0.0.1:47821
  StreamLocalBindUnlink yes
```

开发机（用本 PR 构建的 node-repl，路径按实际修改）：

```bash
qwen mcp add --scope user node-repl node /path/to/qwen-code/packages/node-repl/dist/index.js \
  desktop-relay socket /home/<you>/.qwen/desktop-relay.sock
qwen
```

预期：启动 qwen 时 Mac 上**不**弹框；第一次调用 computer use 时弹框。Allow 后跑第 C.3 步的任务。再开一次 qwen，这次点 Deny，预期模型收到 “declined remote use” 的错误。断开 SSH 后，记录 qwen 里的表现。

## E. 清理

```bash
node packages/node-repl/dist/index.js desktop-relay uninstall --purge
lsof -nP -iTCP:47821 -sTCP:LISTEN   # 预期：无输出
```

## F. 排查手册

先定位是哪一段断了：浏览器 → 本机端口（launchd）→ relay 进程 → 远端 daemon → node_repl → macOS 授权。

**常用观察点**

```bash
cat ~/.qwen/desktop-relay/agent.log                                  # relay 进程的 stderr（launchd 写入）
cat ~/.qwen/desktop-relay/active.json                                # 当前/上一次连接的状态记录（不含 token）
node packages/node-repl/dist/index.js desktop-relay status
launchctl print gui/$(id -u)/com.qwencode.desktop-relay | grep -iE 'state|last exit|runs|path'
pgrep -fl 'desktop-relay agent'                                      # 连接存在时应有一个进程
log show --last 5m --predicate 'process == "osascript"' | tail -20  # 确认框/通知
```

| #   | 现象                                                       | 先查                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 面板显示 Relay not detected                                | 在 Mac 终端执行 B.1 的 `curl`。`curl` 正常而浏览器失败，是浏览器拦截：看开发者工具的 Console 和 Network 里 `127.0.0.1:47821/status` 的错误；Chrome 检查站点设置里的“本地网络访问”权限；Safari 记录具体报错（混合内容或 CORS）。`curl` 也失败，看 #2。                                                                                                                                                                         |
| 2   | `curl` 连接被拒绝或卡住                                    | `lsof -nP -iTCP:47821 -sTCP:LISTEN` 没有输出：launchd 没有注册，重新 install 并看 `launchctl bootstrap` 的报错。有监听但连接立刻断开：看 `agent.log` 和 `launchctl print` 里的 last exit code，常见原因是 plist 里的 node 路径失效（nvm 切换或删除了该版本，重新 install 即可）。有监听但卡住：说明 `net.Socket({ fd: 0 })` 在 inetd 模式下有问题，用 #8 的方法绕开 launchd 对比。                                            |
| 3   | `/connect` 之后没有对话框                                  | 在终端直接执行 `osascript -e 'display dialog "test"'`：终端里能弹出，而 relay 弹不出，说明是 LaunchAgent 的会话问题，记下 `agent.log` 和 `log show` 的输出。对话框在其他窗口后面也算问题，一并记录。                                                                                                                                                                                                                          |
| 4   | 允许后一直停在 Connecting / Registering，或显示 failed     | `active.json` 的 `message` 字段写着原因。`unsupported-daemon` 或注册被拒：确认远端 daemon 启动时带了 `QWEN_SERVE_CLIENT_MCP_OVER_WS=1`（main 上默认关闭）。鉴权失败：检查 token。`register_failed` 且带 `already_registered`：同一会话已有旧注册，重启会话后再试。远端 daemon 日志里搜 `mcp_register`。                                                                                                                       |
| 5   | 已连接，但模型没用 `desktop-node-repl`，或去执行 bootstrap | 在会话里让模型列出可用工具，看有没有 `mcp__desktop-node-repl__*`。没有：注册没成功，回到 #4。有但没用：记录模型读到的 skill 内容，这是 `SKILL.md` 的问题，不是中继的问题。                                                                                                                                                                                                                                                    |
| 6   | 点停止后桌面还在动                                         | 在远端 daemon 上打开 MCP 调试日志，确认 `notifications/cancelled` 有没有通过 `mcp_message` 发出。发出了但桌面没停：确认中继包含 2026-09-25 之后的修复——同一 id 有多个在途请求时取消会转发给所有匹配项，停在确认框上的调用被取消后也不再执行（见 `mcp-child-relay.ts` 的 `matchingRelayIds` 与 `agent.ts` 的确认门）。仍复现时记录当时有几个会话连着这个中继。                                                                 |
| 7   | 截图或操作报授权错误                                       | 系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制，找名为 `node` 的条目（路径应是 install 时打印的那个）。改授权后要断开再连接一次。要从头重测授权流程：先按应用限定范围，例如 `tccutil reset ScreenCapture <bundle-id>`。不限定范围的 `tccutil reset ScreenCapture` / `tccutil reset Accessibility` 会撤销这台 Mac 上**所有**应用（浏览器、IDE、会议软件等）的对应授权，只能在 Mac 主人明确同意后执行——验证 agent 不得自行运行。 |
| 8   | 怀疑是 launchd 的问题                                      | 绕开 launchd 对比：`launchctl bootout gui/$(id -u)/com.qwencode.desktop-relay`，然后 `brew install socat` 并执行 `socat TCP-LISTEN:47821,bind=127.0.0.1,reuseaddr,fork EXEC:"$(which node) $HOME/.qwen/desktop-relay/node_modules/@qwen-code/node-repl-mcp/dist/index.js desktop-relay agent --home $HOME/.qwen/desktop-relay"`，重跑 B 节。socat 下正常而 launchd 下不正常，就说明问题在 launchd 这一层。测完重新 install。  |
| 9   | 报 “above the … byte limit”                                | 截图超过了 daemon 10 MB 的帧上限。记录屏幕分辨率和截图参数；这是已知限制，还没有自动压缩。                                                                                                                                                                                                                                                                                                                                    |

修了代码之后：在 Mac 上重新 `npm run build` 并 `npm pack`，然后重新 install（`--package` 指向新 tarball），否则 launchd 拉起的还是 `~/.qwen/desktop-relay` 里的旧版本。

## 需要回报的内容

写进同一目录下的 `results.md`，推到 PR #11799 的分支（追加提交，不要 force-push），再在 PR 里留一条评论。

| 项                                                                 | 结果 |
| ------------------------------------------------------------------ | ---- |
| macOS 版本 / 芯片 / 屏幕分辨率；Chrome 与 Safari 版本              |      |
| A：安装输出；`launchctl print`、`lsof`、`pgrep` 的结果             |      |
| B：五个请求的结果和耗时；对话框表现；`agent.log` 的报错            |      |
| C.1–2：各状态是否按预期出现；Chrome 是否弹出本地网络权限提示       |      |
| C.3：是否 bootstrap；授权记在谁名下；任务结果；三次调用耗时        |      |
| C.3 取消：点停止后又多出了几个数字；桌面停下来用了多久             |      |
| C.4：截图结果与分辨率                                              |      |
| C.5–7：其他会话、断开、daemon 重启时的表现                         |      |
| C.8：Safari 的差异                                                 |      |
| D：启动时是否弹框；首次 `tools/call` 的确认；Deny 的错误；断开表现 |      |

## 本次验证可能推翻的结论

请逐条注明“成立 / 不成立 / 无法判断”：

1. 方案 §6 第 1 点：inetd 模式下 `net.Socket({ fd: 0 })` 能正常收发，浏览器能立即拿到响应（A、B、C）。
2. 方案 §6 第 2 点：确认框从 LaunchAgent 进程弹出时可见、可点（B.5、C.2）。
3. 方案 §6 第 3 点：Chrome 和 Safari 允许安全页面访问 `http://127.0.0.1:47821`（C.1、C.8）。
4. 方案 §6 第 4 点：授权记在 `node` 名下（C.3）。
5. 方案 §6 第 5 点：模型不执行 bootstrap；截图不超过帧上限（C.3、C.4）。
6. 在 Web Shell 里停止对话，能中止桌面上正在运行的 node_repl 单元（C.3 取消）。
