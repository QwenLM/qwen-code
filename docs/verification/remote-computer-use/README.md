# 片0 验证：远程开发机上的 Qwen Code 经 SSH 反向隧道操作本地 Mac

> 关联：PR #11799；方案见 `docs/plans/2026-09-14-remote-computer-use-mac-companion.md` §3 方案 A；交接见 `docs/plans/2026-09-14-remote-computer-use-handoff.md`。
> 本文所有"预期"都来自读代码（`origin/main` @ `f9534f4395`），**没有在真机上跑过**，这正是本次验证要回答的问题。
> 不需要构建本仓库。只需要一台 Mac 和一台能从 Mac SSH 过去、装好 Qwen Code 的 Linux 开发机。

## 目的

不写任何代码，回答三个问题：

1. 远端 Qwen Code 能否通过 cua-driver 的 HTTP MCP 加 `ssh -R`，在本地 Mac 上完成观察、点击、输入？
2. 单步往返延迟是多少？一张截图有多大？
3. 驱动守护进程的 HTTP 端点在 macOS 上怎样才能真正打开，权限最终记在谁名下？

结果决定计划里的方案 C 是否继续，以及 Mac 伴侣要不要做截图压缩。本次验证**不需要做任何决定**；决策点列在交接文档 §4。

## 已知的坑（先读）

HTTP 端点只能通过守护进程的环境变量 `CUA_DRIVER_RS_MCP_HTTP_PORT` 和 `CUA_DRIVER_RS_MCP_HTTP_TOKEN` 打开。但在 macOS 上，`qwen-cua-driver mcp` 和 `qwen-cua-driver permissions grant` 会用 `open -n -g -a QwenCuaDriver --args serve` 通过 LaunchServices 拉起守护进程，这条路径只转发 `--socket` 和 `--grant` 参数，**不转发环境变量**（`cli.rs:1121-1235`）。

所以被自动拉起的守护进程**不会**开 HTTP 端点，而且不会报错。第 3 步专门处理这一点，并用 `lsof` 确认。

## 步骤

下文的 `8765` 是示例端口；开发机上被占用就换一个，并在所有步骤里同步替换。

### 1. Mac：安装驱动

```bash
CUA_DRIVER_RS_VERSION=0.20.6 \
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/install.sh)"
```

预期安装后能看到 `qwen-cua-driver 0.20.6`，并出现 `/Applications/QwenCuaDriver.app`（bundle id `com.qwencode.cua-driver`）。

### 2. Mac：授权

```bash
qwen-cua-driver permissions grant
```

按提示在"系统设置 → 隐私与安全性"里，给 QwenCuaDriver 打开"辅助功能"和"屏幕录制"。

这个命令会顺带拉起一个**不带 HTTP 端点**的守护进程。进入下一步前先停掉它：

```bash
pgrep -fl QwenCuaDriver        # 记录输出
pkill -f QwenCuaDriver.app
pgrep -fl QwenCuaDriver        # 预期：无输出
```

### 3. Mac：带 HTTP 端点启动守护进程

```bash
TOKEN="$(openssl rand -hex 32)"
echo "$TOKEN"                  # 记下来，第 5 步要用
```

**方式 A（先试）**：经 LaunchServices 启动，权限应记在 QwenCuaDriver 名下。

```bash
open -n -g -a QwenCuaDriver \
  --env CUA_DRIVER_RS_MCP_HTTP_PORT=8765 \
  --env CUA_DRIVER_RS_MCP_HTTP_TOKEN="$TOKEN" \
  --args serve
```

`open --env` 只有较新的 macOS 才支持。如果报不认识这个参数，改用方式 B，并记录 macOS 版本。

**方式 B**：在终端前台直接运行。全仓只有 `mcp` 代理和 `permissions grant` 两处会走 LaunchServices 重新拉起（`cli.rs:1332`、`cli.rs:2837`），所以直接跑 `serve` 会留在当前进程，环境变量能生效。

```bash
CUA_DRIVER_RS_MCP_HTTP_PORT=8765 CUA_DRIVER_RS_MCP_HTTP_TOKEN="$TOKEN" \
  qwen-cua-driver serve
```

此时 macOS 可能把权限算在终端（Terminal / iTerm）头上，需要给终端也打开辅助功能和屏幕录制。记录实际发生的情况。

**不管用哪种方式，都要确认端点真的开了**（这是最容易静默失败的一步）：

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
# 预期：一行，监听 127.0.0.1:8765

curl -s -X POST http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 400
# 预期：以 {"jsonrpc":"2.0","id":1,"result":{"tools":[ 开头
# 把完整输出存一份，第 7 步要从里面找截图工具

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8765/mcp \
  -H 'Authorization: Bearer wrong' -d '{}'
# 预期：401

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Origin: https://example.com' -d '{}'
# 预期：403
```

### 4. Mac：建立反向隧道

```bash
ssh -N -R 8765:127.0.0.1:8765 <devbox>
```

保持这个窗口开着。

### 5. 开发机：注册 MCP

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8765/mcp \
  -H 'Authorization: Bearer wrong' -d '{}'
# 预期：401，说明隧道已经通到 Mac

qwen mcp add --scope user --transport http cua http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer <第 3 步的 TOKEN>"

qwen mcp list
# 预期：cua 显示已连接
```

`--scope user` 会把 token 写进开发机的用户设置，验证结束后按第 9 步删除。

### 6. 开发机：跑一个真实任务

在开发机上启动 `qwen`，保持默认审批模式（不要开 YOLO），输入：

> 用 cua 这个 MCP 服务器提供的工具，在我的 Mac 上打开"备忘录"，新建一条备忘录，内容写 hello from remote。每一步操作之后都重新读取界面状态，确认结果。

提示词里不要提 computer-use skill。如果模型仍然试图执行 skill 的 bootstrap（`qwen mcp add ... node-repl` 或 `npm install @qwen-code/cua-sdk`），拒绝这次 shell 调用并记录下来。

### 7. 测量

- **单步往返**：在开发机上对隧道重复 5 次，取中位数：

  ```bash
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null -w '%{time_total}\n' -X POST http://127.0.0.1:8765/mcp \
      -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
  done
  ```

  同时记录第 6 步任务里 3 次真实工具调用的耗时（qwen 界面上显示的时间即可）。

- **截图体积**：从第 3 步的 `tools/list` 输出里找到截图工具（名字里带 screenshot 或 capture），按它的 `inputSchema` 填参数，调用一次并统计字节数：

  ```bash
  curl -s -X POST http://127.0.0.1:8765/mcp \
    -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<工具名>","arguments":{<参数>}}}' \
    | wc -c
  ```

  至少测一次全屏截图；如果是 Retina 屏，请注明。

### 8. 失败路径

- 关掉第 4 步的隧道窗口，在 qwen 里让模型再读一次界面。预期：工具调用给出明确的错误，而不是一直挂起。记录错误文本和等了多久。
- 重新打开隧道，看工具能否恢复，以及是否需要重启 qwen 或执行 `qwen mcp reconnect`。

### 9. 清理

```bash
# 开发机
qwen mcp remove cua

# Mac：方式 A
pkill -f QwenCuaDriver.app
# Mac：方式 B
# 在运行 serve 的终端里按 Ctrl-C
```

token 只存在于守护进程的环境变量里，进程停掉后自然失效。

## 需要回报的内容

写进同一目录下的 `results.md`，推到 PR #11799 的分支（追加提交，不要 force-push），再在 PR 里留一条评论。

| 项                                                        | 结果 |
| --------------------------------------------------------- | ---- |
| macOS 版本 / 芯片 / 屏幕是否 Retina                       |      |
| 开发机上 `qwen --version`                                 |      |
| 第 3 步用的方式；`open --env` 是否可用                    |      |
| 权限最终记在谁名下（系统设置里列出的是哪个应用）          |      |
| `lsof` 输出；三个 `curl` 的状态码和 `tools/list` 开头部分 |      |
| `qwen mcp list` 输出                                      |      |
| 任务是否完成；用到了哪些工具；失败的调用和错误文本        |      |
| 是否出现 skill bootstrap 尝试                             |      |
| 经隧道 `tools/list` 的往返中位数；3 次真实调用的耗时      |      |
| 全屏截图的响应字节数                                      |      |
| 断开隧道后的错误表现和等待时长；恢复方式                  |      |

## 本次验证可能推翻的结论

请逐条注明"成立 / 不成立 / 无法判断"：

1. 计划 §5 事实 1–4：驱动的 HTTP 端点行为，以及 Qwen 的 HTTP MCP 客户端能与它完成握手。
2. 计划 §3 方案 A：在终端直接运行 `serve` 就足够，还是必须用方式 A 才能拿到正确的权限归属。
3. 计划 §6 第 3 点：截图体积是否接近 `/acp` 的 10 MB 单帧上限。
4. 本文"已知的坑"：自动拉起的守护进程确实不开 HTTP 端点。验证方法：跳过第 2 步的 `pkill`，直接做第 3 步的 `lsof` 检查，预期没有监听。
