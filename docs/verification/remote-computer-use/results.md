# 验证结果：远程会话使用本地 Mac（PR #11799）

## 结论

核心用户路径已通过：Linux 上的 `qwen serve` 经 Mac 浏览器发起连接，用户在 Mac 原生对话框中允许后，远程会话可以调用 Mac 上的 Computer Use；会话切换保持、按会话隔离和主动断开撤销也已验证。

2026-09-26 最终候选在此前真机结果之上完成了 review 收口：删除未完整验证的 SSH/raw MCP 分支，只保留 Web Shell 路径；完整 daemon bearer 不再发送到本机固定端口，改为一次性、短时、绑定 ACP 路径和 session 的凭证；并修复启动失败、事件订阅被驱逐、瞬时探测失败和远端 daemon 选择等失败路径。

结论是 **Ready for review**，不是“所有平台均已发布可用”。公开 `@latest` 安装命令仍依赖合并后的 npm 包发布。

## 真机验收（2026-09-25）

拓扑：Mac Chrome 通过 SSH local-forward 打开 Linux Serve；Mac launchd 按需拉起 desktop relay，relay 主动连接 Linux daemon 的 ACP WebSocket，并把 `desktop-node-repl` 注册到目标 session。

| 场景                                                                | 结果 |
| ------------------------------------------------------------------- | ---- |
| launchd socket activation、连续 `/status`、空闲零进程               | 通过 |
| Chrome 探测 relay、用户看到原生确认框并点击 Allow                   | 通过 |
| 平台归属：shell=`linux`、desktop MCP=`darwin`、Computer Use=`macos` | 通过 |
| 远程会话读取并修改独立的 Mac 测试文稿                               | 通过 |
| 仅截取测试内容区并 flatten 白底，独立目检隐私                       | 通过 |
| 第二 session 看不到桌面工具，返回原 session 后工具与 REPL 状态仍在  | 通过 |
| 非 GUI 长 cell 取消，超过 30 秒后继续调用                           | 通过 |
| Disconnect 后 relay 停止、工具撤销且不自动重连                      | 通过 |

公开报告和五张已检查隐私信息的截图见 [PR 测试报告评论](https://github.com/QwenLM/qwen-code/pull/11799#issuecomment-5832844845)。截图只包含连接面板、脱敏后的工具结果、独立测试文稿和断开结果；没有服务器 IP、token、session ID、私人路径或整块桌面。原生授权框没有合格截图，因此只记录用户明确确认和后续 connected/工具执行证据，不制作替代图。

## 最终代码验证（2026-09-26）

运行环境：Node 22，基于 PR 合并最新主干后的最终工作树。

| 验证                                                   | 结果                 |
| ------------------------------------------------------ | -------------------- |
| CLI auth、client MCP 生命周期、ACP transport、静态 CSP | 4 个文件，486 项通过 |
| Serve 受限凭证路由专项                                 | 1 项通过             |
| desktop relay 全目录                                   | 8 个文件，62 项通过  |
| Web Shell client、panel、sidebar、Vite CSP             | 4 个文件，55 项通过  |
| core SDK cancellation 与 Computer Use skill            | 2 个文件，8 项通过   |
| `npm run build`                                        | 通过                 |
| `npm run typecheck`                                    | 通过                 |
| `npm run lint`                                         | 通过                 |

聚焦回归共 612 项。CLI 首次并行执行时两个 Vitest 进程争用同一个 coverage 临时目录，断言已全部通过但产生环境型 `ENOENT`；随后按单进程完整重跑 486 项并干净通过，最终结论只采用重跑结果。

受限凭证回归同时证明：

- 凭证不是普通 daemon bearer，不能访问普通 API；
- 只能消费一次，错误 ACP 路径也会立即消耗；
- 2 分钟后过期；
- WebSocket 客户端必须声明为 `qwen-desktop-relay`；
- 只能注册 `desktop-node-repl` 到签发时指定的 session；
- 初始化后发送普通 ACP session 请求会被 1008 关闭。

## 仍未覆盖和残余风险

- Safari；
- 全新 Mac 的首次安装与首次 TCC 授权；
- 连续 GUI 输入过程中的取消（非 GUI 取消已通过）；
- HTTPS 直连部署；HTTP + 服务器 IP 的引导由 #12696 跟进；
- macOS TCC 当前归属于 launchd 拉起的共享 Node 可执行文件。更强的产品身份隔离需要独立签名 helper，超出本 PR 的最小 Web Shell 中继范围。

SSH/raw MCP 传输不再属于本 PR，不列为“待验收功能”。若未来确实需要无浏览器的终端配对，应独立设计身份、发现、撤销和背压机制，而不是恢复本次删除的旁路。
