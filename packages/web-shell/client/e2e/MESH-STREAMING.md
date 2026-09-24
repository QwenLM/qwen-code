# Mesh 实时回复：可重复执行的浏览器验收

测试文件：`web-shell.mesh-streaming.spec.ts`。复用仓库已有 Node + Playwright、Chromium 和 mockDaemon，不新增依赖，不跑目录扫描。需要 Node 22+、已安装的仓库依赖及 Playwright Chromium（首次可在本包执行 `npx playwright install chromium`）。

## 1. 日常页面回归（无模型费用）

从仓库根目录执行：

```bash
cd packages/web-shell
node ../../node_modules/@playwright/test/cli.js test client/e2e/web-shell.mesh-streaming.spec.ts --project=chromium --workers=1 --grep-invert @mesh-live
```

现有 Playwright 配置会启动或复用本地 Vite。运行真实 App、聊天输入框、轮询和消息渲染，只有 daemon HTTP 响应由现有 mockDaemon 与测试内的协作接口替身提供。替身状态留在 Node 测试进程中，页面刷新不会清空它。

一条连续流程检查：

- 从聊天输入框发送 `@stream-worker`，只发送一次。
- 排队时显示排队等待；启动后看到两段思考内容的累计增长，刷新仍可读。
- run 仍 running、正式结果未产生时，正文先后显示两段累计文本。
- 刷新页面后仍显示中间正文，不重新提交任务。
- 超过 20 秒没有遥测时显示连接待确认，已显示的正文不丢失。
- 正式结果替代实时预览，正文只出现一次，刷新后仍只有一次。

敏感性：如果把正文渲染改回“仅 completed 才显示”，本测试会在第一段正文断言失败；删除 sourceRunId 去重会使最终单条断言失败。**此模式不证明模型输出、真实服务落盘或跨机器互通。**

为专注正文恢复，测试通过浏览器初始化脚本选中协作对话，每次刷新都指定同一个对话；不把它算作“侧边栏选择记忆”的验收。

## 2. 真实 Agent + 浏览器（显式启用，会使用模型额度）

先启动这条分支的协作 daemon，并确认目标工作区中已有启用的 Agent、模型已登录。不要用日常忙碌中的 Agent；建议使用专门的 demo Agent。脚本不会创建 Agent、切换权限、登录模型或改写工程文件。

例如在仓库根目录启动 daemon：

```bash
QWEN_CODE_ENABLE_AGENT_COLLABORATION=1 npm run dev -- serve --hostname 127.0.0.1 --port 4171 --workspace "$PWD" --no-open
```

另开终端，在 `packages/web-shell` 启动前端：

```bash
QWEN_DAEMON_URL=http://127.0.0.1:4171 npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

再从 `packages/web-shell` 执行（目录必须与服务注册的工作区完全一致，Agent 名称必须已存在）：

```bash
MESH_E2E_CWD='/absolute/path/to/registered/project' \
MESH_E2E_AGENT='demo-worker' \
node ../../node_modules/@playwright/test/cli.js test client/e2e/web-shell.mesh-streaming.spec.ts --project=chromium --workers=1 --grep @mesh-live --retries=0
```

这里使用 loopback 免登录演示服务；不自动处理远程鉴权。前端地址不同时用 `PLAYWRIGHT_BASE_URL` 指向已启动的前端，并确认其代理指向正确 daemon。不要把凭证写进脚本或截图。

此模式通过真实 API 新建一个 `E2E live stream ...` 对话，随后在真实聊天框中发送消息。必须在结束前看到至少两次增长的正文；第一次增长后刷新验证恢复；完成后从真实 API 确认一条正式结果，并再次刷新确认页面没有重复。不会把“只出现最终结果”算通过。

本地 Qwen 必须调用 `thread_review` 才算交回验收，因此测试允许该协作工具，仅禁止文件修改、命令和联网；不要把提示词改成笼统的“禁止所有工具”。

为保留失败现场，测试对话不会删除；报告附有其 ID。测试 finally 仅请求取消本次新建对话里仍活跃的 run，不触碰其他任务。进程被强杀时 finally 无法保证执行，请根据报告中的对话 ID 手动检查。

## 结果与边界

截图和附件在 `client/e2e/test-results/`；HTML 报告在 `client/e2e/playwright-report/`。打开报告：

```bash
node ../../node_modules/@playwright/test/cli.js show-report client/e2e/playwright-report
```

成功流程也保存 growing/completed 截图；真实模式附 `created-thread` 和 `live-observations`（每次正文增长的耗时与字符数）。现有配置会在失败时保留截图、视频。需要完整首次 trace 时在运行命令追加 `--trace on`。这些产物可能包含对话信息，不要直接上传公开 PR。

没有设置真实模式的两个环境变量时，真实模式明确显示 skipped，不代表已验收。真实模型可能在首段前等待较久，或一次性返回太短文本；若无法观测到两次增长，此项必须失败而不是放宽成“最终能回复”。

本次记录（2026-09-14）：默认页面回归 `1 passed (13.5s)`，真实模式未执行。首次运行因状态文字旁包含取消按钮导致精确文本定位失败，修正为定位 Agent activity 面板后重跑通过；没有放宽正文增长或去重断言。

后续补充（同日）：加入排队与思考增量断言后，默认回归 `1 passed (13.0s)`；真实本地 Qwen 模式 `1 passed (1.0m)`。同步观察到 31 次思考增长、17 次正文增长，正式结果为一条。真实运行的思考采样和截图操作也补入本脚本。
