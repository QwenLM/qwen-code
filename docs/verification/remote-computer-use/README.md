# 验证：远程开发机上的 Qwen Code 经 node_repl 中继操作本地桌面机（本轮：macOS）

> 关联：PR #11799；方案见 `docs/plans/2026-09-14-remote-computer-use-desktop-relay.md`；交接见 `docs/plans/2026-09-14-remote-computer-use-handoff.md`。
> 本文所有"预期"都来自读代码（`origin/main` @ `c666ec1a0a`），**没有在真机上跑过**。
> 不需要构建本仓库。A 部分只需要一台 Mac；B 部分还需要一台能从 Mac 连到、装好 Qwen Code 并以 `qwen serve` 运行的 Linux 开发机，以及片1 的 `qwen bridge` 子命令。

## A. 事实核对（不写代码，约十分钟）

回答两个问题：方案 §1 说"standalone 守护进程拒绝 SDK 的 `connect()`"，真机上是不是这样；一张全屏截图经 base64 后有多大。

### A1. Mac：准备 SDK

在任意空目录：

```bash
mkdir -p ~/cua-check && cd ~/cua-check
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.6
# 预期：postinstall 打印 "@qwen-code/cua-sdk native payload ready: ..."
```

### A2. Mac：本地路径能用

```bash
node --input-type=module -e '
const { ComputerUse } = await import("@qwen-code/cua-sdk/computer-use");
const c = await ComputerUse.create();
console.log("platform:", await c.getPlatform());
await c.close();
'
# 预期：platform: macos
# 第一次运行会弹出辅助功能 / 屏幕录制授权；记下系统设置里列出的是哪个应用（预期是终端）
```

### A3. Mac：standalone 守护进程拒绝 `connect()`

```bash
# 窗口 1
qwen-cua-driver serve
# 没装的话：CUA_DRIVER_RS_VERSION=0.20.6 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/install.sh)"

# 窗口 2
cd ~/cua-check
node --input-type=module -e '
const { ComputerUse } = await import("@qwen-code/cua-sdk/computer-use");
try {
  const c = await ComputerUse.connect({});
  console.log("UNEXPECTED: connected, platform", await c.getPlatform());
  await c.close();
} catch (e) { console.log("rejected:", e.message); }
'
# 预期：rejected: ... trusted service sessions require the original authenticated embedded host connection ...
# 如果输出 UNEXPECTED，方案 §1 第二条不成立，请把完整输出贴进 results.md
```

### A4. Mac：全屏截图体积

```bash
node --input-type=module -e '
const { ComputerUse } = await import("@qwen-code/cua-sdk/computer-use");
const c = await ComputerUse.create();
const apps = await c.listApps();
const app = await c.getApp(apps.find(a => /Finder/.test(a.name))?.name ?? apps[0].name);
const s = await app.getState({ includeScreenshot: true });
console.log(JSON.stringify(s).length, "bytes as JSON");
await c.close();
'
```

如果 `listApps` / `getApp` / `getState` 的名字不对，按 `node_modules/@qwen-code/cua-sdk/computer-use/index.d.ts` 里的实际 API 调整，目的只是拿到一次带截图的观察并统计 JSON 字节数。注明屏幕是否 Retina 和分辨率。

## B. 片1 验收（需要 `qwen bridge` 子命令）

### B1. 开发机：以 daemon 方式运行，拿到会话

```bash
qwen serve            # 记下监听地址和 token
```

在 Web Shell 里新建一个会话，记下 `sessionId`。

### B2. Mac：在终端里启动中继

```bash
qwen bridge --daemon <url> --token <token> --session <sessionId>
# 预期：打印 initialize 完成、mcp_register 成功、tools/list 被调用 N+1 次
# 首次运行如弹出辅助功能 / 屏幕录制授权，记下系统设置里列出的应用（预期是终端）
```

### B3. 开发机：工具可见性

在那个会话里让模型列出可用工具：预期出现 `node_repl`。在同一 workspace 的**另一个**会话里重复：预期不出现。

### B4. 开发机：跑一个真实任务

保持默认审批模式（不要开 YOLO），输入：

> 用 computer use 在我的 Mac 上打开"备忘录"，新建一条备忘录，内容写 hello from remote。每一步操作之后都重新读取界面状态，确认结果。

观察并记录：

- 模型是否执行了 bootstrap（`qwen mcp add ... node-repl` 或 `npm install @qwen-code/cua-sdk`）。预期：没有。出现了就拒绝这次 shell 调用并记录。
- `getPlatform()` 是否返回 `macos`。
- 读参考文档那一步走的是 `read_file` 还是 `node_repl` 里的 `readFile`；后者预期失败（Mac 上没有那个路径），这就是 skill 要改的地方。
- 任务是否完成；失败的调用和错误文本。
- 3 次真实 `node_repl` 调用的耗时（qwen 界面上显示的时间即可）。
- 带截图的那次观察，中继进程日志里的帧大小；是否触发 10 MB 上限。

### B5. 失败路径

- 在终端里 Ctrl-C 结束中继。预期：会话里 `node_repl` 工具消失；模型再调用时得到明确错误，不是一直挂起。记录错误文本和等待时长。
- 重新运行 `qwen bridge`。预期：工具恢复，不需要重启远端 qwen。
- Mac 睡眠再唤醒。记录中继是否自动重连。

## 需要回报的内容

写进同一目录下的 `results.md`，推到 PR #11799 的分支（追加提交，不要 force-push），再在 PR 里留一条评论。

| 项                                                | 结果 |
| ------------------------------------------------- | ---- |
| macOS 版本 / 芯片 / 屏幕是否 Retina 及分辨率      |      |
| A2：`getPlatform()` 输出；授权记在哪个应用名下    |      |
| A3：`connect()` 的完整错误文本                    |      |
| A4：带截图观察的 JSON 字节数                      |      |
| B3：两个会话里 `node_repl` 的可见性               |      |
| B4：是否出现 bootstrap；读参考文档走的是哪条路    |      |
| B4：任务是否完成；失败的调用和错误文本            |      |
| B4：3 次 `node_repl` 调用的耗时；最大帧大小       |      |
| B5：Ctrl-C 后的错误表现和等待时长；重启后是否恢复 |      |

## 本次验证可能推翻的结论

请逐条注明"成立 / 不成立 / 无法判断"：

1. 方案 §1：standalone 守护进程拒绝 `connect()`（A3）。
2. 方案 §1：`create()` 的授权落在拉起 node 的进程身份上（A2）。
3. 方案 §6 第 1 点：模型看到已注册的 `node_repl` 就不执行 bootstrap（B4）。
4. 方案 §3.2：读参考文档必须改用 `read_file`（B4）。
5. 方案 §6 第 2 点：截图体积是否接近 10 MB 帧上限（A4、B4）。
