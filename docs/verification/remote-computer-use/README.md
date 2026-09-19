# 验证：远程会话经 launchd 中继使用本地桌面机（本轮：macOS）

> 关联：PR #11799；方案见 `docs/plans/2026-09-14-remote-computer-use-desktop-relay.md`（§6 列出了本文要回答的未验证项）；交接见 `docs/plans/2026-09-14-remote-computer-use-handoff.md`。
> 本文所有“预期”都来自读代码，**代码没有在任何机器上构建、测试或运行过**。
> 需要：一台 Mac（Chrome，最好再有 Safari）；一台能从 Mac 用 SSH 连到的 Linux 开发机。两边都要能构建本 PR。

## 0. 准备

两台机器都检出本 PR 分支并构建：

```bash
git fetch https://github.com/yiliang114/qwen-code docs/remote-computer-use-plan
git checkout FETCH_HEAD
npm ci && npm run build && npm run bundle
```

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

1. 新建会话。侧边栏底部点显示器图标（“Use this computer”）。预期状态：Not connected。如果显示 Not set up，说明探测失败，记录浏览器控制台的错误。
2. 点 **Connect this computer**。预期：状态变为 Waiting for approval，桌面弹出确认框。点 Allow。预期：状态变为 Connecting…，随后 Connected；系统通知“is now using this computer”。
3. 在同一会话里输入（保持默认审批模式）：

   > 用 computer use 在我的 Mac 上打开“备忘录”，新建一条备忘录，内容写 hello from remote。每一步操作之后都重新读取界面状态，确认结果。

   记录：模型是否执行了 bootstrap（`qwen mcp add … node-repl` 或 `npm install @qwen-code/cua-sdk`，出现就拒绝并记录）；`getPlatform()` 是否返回 `macos`；读参考文档走的是哪条路；macOS 的授权提示弹给了谁（预期是 `node`）；授权后是否需要重新连接；任务是否完成；3 次 `node_repl` 调用的耗时。

4. 让模型截一张全屏图（`app.getState({ includeScreenshot: true })`）。记录是成功还是得到“above the … byte limit”错误；注明屏幕分辨率。
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

## 需要回报的内容

写进同一目录下的 `results.md`，推到 PR #11799 的分支（追加提交，不要 force-push），再在 PR 里留一条评论。

| 项                                                                 | 结果 |
| ------------------------------------------------------------------ | ---- |
| macOS 版本 / 芯片 / 屏幕分辨率；Chrome 与 Safari 版本              |      |
| A：安装输出；`launchctl print`、`lsof`、`pgrep` 的结果             |      |
| B：五个请求的结果和耗时；对话框表现；`agent.log` 的报错            |      |
| C.1–2：各状态是否按预期出现；Chrome 是否弹出本地网络权限提示       |      |
| C.3：是否 bootstrap；授权记在谁名下；任务结果；三次调用耗时        |      |
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
