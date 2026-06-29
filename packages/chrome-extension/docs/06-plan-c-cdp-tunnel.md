# Plan C — CDP 隧道：复用 chrome-devtools-mcp 全套工具驱动真实浏览器

> 设计文档（可行性 + 实施方案）。配套：[`05-daemon-direct-architecture.md`](./05-daemon-direct-architecture.md)（Phase 1/2 已落地：side panel + 逆向工具通道 `chrome-tools`）。
> 关联 issue #5626 / PR #5777。

## 0. TL;DR

- **问题**：当前 `chrome-tools` 逆向通道（Plan A）在扩展端用 `chrome.*` **重新实现** chrome-devtools-mcp 已有的能力（console / network / screenshot…），每加一个新能力都要手写 executor。
- **Plan C**：扩展只用 `chrome.debugger` 把真实标签页的 **CDP 协议**透传给 daemon，daemon 暴露一个 CDP endpoint 让 **chrome-devtools-mcp（puppeteer）连进来** —— 复用它现成的全套工具，操作用户**真实**浏览器，不再逐个手写。
- **结论：有条件可行**。能让 puppeteer 连上单 tab（命题 A，可行）；但「把*未改的* chrome-devtools-mcp 直接接上」（命题 B）**不可行 —— 必须给它打一个小补丁**（patch-package，~2 处 / 十几行 diff）。
- **形态**：不扣代码、不 submodule。`chrome-devtools-mcp` 从 `npx @latest` 改成仓库 pin 依赖 `1.4.0` + 一个 `patches/chrome-devtools-mcp+1.4.0.patch`（与现有 `ink+7.0.3.patch` 同形态）。
- **建议**：先做 Phase 0 半天 spike 钉死那堵墙，再决定是否全量上。

## 1. 决定性发现：为什么「零改造复用」不行（已逐行核实 1.4.0 源码）

1. **puppeteer 的硬墙**：`Connection._createSession`（`cdp/Connection.js:232`）在 `createCDPSession()` 时**无条件**发 `Target.attachToTarget {flatten:true}`，拿不到 `sessionId` 就 `throw new Error('CDPSession creation failed.')`。
2. **chrome.debugger 拒绝**：对 `Target.attachToTarget` 返回 `-32000 'Not allowed'`（Puppeteer issue #13251，OPEN/confirmed，属 Chrome 安全限制，非 bug）。
3. **官方原语堵不住**：puppeteer 自带的 `cdp/ExtensionTransport.js` 只合成 4 条命令（`Browser.getVersion` / `Target.getBrowserContexts` / `Target.setDiscoverTargets` / `Target.setAutoAttach`），**没有 `attachToTarget` 分支**，fall-through 到 `chrome.debugger.sendCommand` → 被拒。
4. **cdp-mcp 把它放在强制启动路径且不吞异常**：`McpContext.from()` → `#init()`（`build/src/McpContext.js:76-83`）无条件调 `UniverseManager.init` 与 `ServiceWorkerConsoleCollector.init`，二者在 `DevtoolsUtils.js:166` / `ServiceWorkerCollector.js:19` 调 `page.createCDPSession()` → 撞墙 → **在第一个工具被调用前整体启动失败**。

### patch 实测（1.4.0）

`createCDPSession` 在 cdp-mcp **自己代码**里仅 2 处，都在 `#init` 路径：

| 文件:行                                   | 触发点                                                      | 处理             |
| ----------------------------------------- | ----------------------------------------------------------- | ---------------- |
| `build/src/devtools/DevtoolsUtils.js:166` | `UniverseManager.init` ←`McpContext.#init:81`               | try-catch / 跳过 |
| `build/src/ServiceWorkerCollector.js:19`  | `ServiceWorkerConsoleCollector.init` ←`McpContext.#init:82` | try-catch / 跳过 |

（`third_party/` 里另有 3 处是 puppeteer/lighthouse 库自带的方法定义，不碰。）

**最小 patch**：把 `McpContext.#init` 的第 81、82 行 try-catch 包住（或 stub），核心 2 处改动、patch 文件 ~10-20 行 diff。
**代价**：`performance_*`（trace/insight）、service-worker console 这类依赖额外 CDP session 的工具降级；page 级核心（snapshot/click/fill/screenshot/network/console/emulation）不受影响。

### 生命周期对抗审查结论

- ✅ **「MV3 30s idle teardown 掐断 debug session」是假的** —— Chrome 118+ active debugger session 保活 SW + 116+ WS 收发重置 idle 计时器，双覆盖，无需额外 keepalive。
- ⚠️ 必须自己补的胶水：`ExtensionTransport` **没注册 `chrome.debugger.onDetach`**，用户开 DevTools / 点 banner Cancel / 页面崩溃时 puppeteer 不被通知 → 须 `onDetach → onclose + 重连`。
- 其余为可处理降级项：5 分钟单请求硬上限（puppeteer 默认 `protocolTimeout=180s` 会先报错）、调试 banner（UX，不可避免）、单 tab 单 debugger 互斥（与现有 `chrome_network_debugger_*` 加互斥门）。

## 2. 架构

```
chrome-devtools-mcp(fork)      qwen serve daemon              扩展(MV3)        真实 tab
 puppeteer.connect   browser级  ┌ /cdp WS endpoint ┐  reverse  cdp-bridge   chrome.
 ({browserWS}) ───CDP───────▶  │ CdpBrowserEmulator│   WS /acp  chrome.      debugger
                               │ ①本地应答browser域│ cdp_command .debugger ──▶ Page/DOM
   page域命令(sessionId=S1)─▶  │ ②合成attachedTo-  │ ────────▶  .sendCommand    /Net/...
   ◀── result/event           │   Target(S1)      │ cdp_event  onEvent ◀──── events
                               │ ③去/贴 sessionId  │ ◀────────
                               └ cdp-reverse-link ┘
 规则：有 sessionId ⇒ 转发给 tab；无 sessionId ⇒ daemon 本地应答（browser 域 ~6 条）
```

组件：

- **chrome-devtools-mcp (patched) + puppeteer-core**：`puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:PORT/cdp' })`。
- **daemon `/cdp` WS endpoint（新增）**：raw CDP 帧 + `CdpBrowserEmulator`（browser-level 合成 + sessionId 打/解标签）。
- **daemon 现有 `/acp` reverse WS**：扩展已建立、过了 ACP-initialize 鉴权的那条 socket，新增 `cdp_*` 帧。
- **cdp-reverse-link**：把 `/cdp` puppeteer socket 与扩展 `/acp` 连接配对（单 daemon = 单扩展 = 单 browser）。
- **扩展 `cdp-bridge`（新增）**：把现有 network-only 的 `chrome.debugger` 泛化为全 domain 透传 + `onDetach`。

## 3. 最小要模拟的 browser-level CDP（全部由 daemon `CdpBrowserEmulator` 本地应答）

| 命令/事件                           | 作用                                                                                         | 难度        |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ----------- |
| `Target.getBrowserContexts`         | connect 首条，回 `{browserContextIds:[]}`                                                    | boilerplate |
| `Browser.getVersion`                | 静态返回 / 从 tab 透传                                                                       | boilerplate |
| `Target.setDiscoverTargets`         | ack `{}`                                                                                     | boilerplate |
| `Target.setAutoAttach {flatten}`    | **承重**：收到后 daemon **合成 `Target.attachedToTarget`**(新 sessionId=S1 + tab targetInfo) | 关键        |
| `Target.getTargets`/`getTargetInfo` | 返回唯一 page TargetInfo                                                                     | boilerplate |
| 事件 `Target.attachedToTarget`      | 给 puppeteer 它的 Page，必需                                                                 | 关键        |
| 事件 `Target.detachedFromTarget`    | onDetach 时补（ExtensionTransport 缺）                                                       | 关键        |
| 所有 page 域命令(带 sessionId)      | **扩展** `chrome.debugger.sendCommand({tabId})`                                              | 已有先例    |

路由规则：有顶层 `sessionId` ⇒ 去标签→`cdp_command`→扩展 sendCommand→回 `cdp_result` 重贴 sessionId；`onEvent`→`cdp_event` 贴 sessionId。browser 域回复不带 sessionId。

## 4. 可复用资产

| 资产                                                                 | 省工                                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| puppeteer 内置 `cdp/ExtensionTransport.js`                           | 4 条 browser 命令合成 + 单 page 拓扑可移植进 daemon。**要补** onDetach / detachedFromTarget / attachToTarget。                                                  |
| `ConnectionTransport` 接口（`send`/`close`/`onmessage?`/`onclose?`） | daemon reverse 通道契约极薄。                                                                                                                                   |
| **microsoft/playwright-mcp `--extension`**（Apache-2.0）             | 官方同构先例：MV3 `chrome.debugger` attach 用户 tab → CDP over WS relay。可参考/fork。                                                                          |
| remorses/playwriter（MIT, 3.6k★, 活跃）                              | 扩展 + WS CDP relay，外部 client `connectOverCDP` 驱动真实已登录浏览器。                                                                                        |
| 本仓库 `/acp` reverse 通道                                           | `WebSocketServer({noServer:true})` + pathname 分支 + `clientMcpOverWs` 式 feature-flag + `mcp_*` 帧拦截 —— `cdp_*` 帧照搬，鉴权/CSRF/origin/maxPayload 全复用。 |

## 5. patch-package 形态（不扣代码、不 submodule）

本仓库已用 patch-package（`postinstall: patch-package` + `patches/ink+7.0.3.patch` 样例）。

```jsonc
// package.json
"dependencies": { "chrome-devtools-mcp": "1.4.0" }   // pin，不再 npx @latest
```

流程：改 `node_modules/chrome-devtools-mcp/build/src/McpContext.js`（try-catch 包 #init:81-82）→ `npx patch-package chrome-devtools-mcp` → 生成 `patches/chrome-devtools-mcp+1.4.0.patch`（进 git）→ `npm install` 自动应用。puppeteer-core pin 25.2.0（ExtensionTransport 拓扑硬编码，避免版本漂移）。

## 6. 分阶段实施

- **Phase 0 — spike（0.5–1 天）**：独立脚本起最小 `/cdp` + ExtensionTransport 4 命令合成，跑*未改的* `chrome-devtools-mcp@1.4.0 --wsEndpoint ws://…/cdp` 调一次 `take_snapshot`，**确认它在 `McpContext.from()` 抛 `CDPSession creation failed.`** → 钉死 fork 范围。
- **Phase 1 — MVP（5–8 天）**：单 tab `take_snapshot`/`click` 跑通。
  - daemon 新增 `packages/cli/src/serve/cdp-tunnel/{cdp-ws,cdp-browser-emulator,cdp-reverse-link}.ts`。
  - daemon 改 `acp-http/index.ts`（upgrade 加 `/cdp` 分支，复用 auth/CSRF/origin）+ reverse WS 加 `isCdpFrameType` 守卫；`run-qwen-serve.ts`/`server.ts`/`serve/types.ts`/`serve/capabilities.ts` 加 `cdpTunnelOverWs` flag（仿 `clientMcpOverWs`，默认 OFF）。
  - 扩展新增 `cdp-bridge.ts`（attach 活动 tab、全 domain 透传、`onDetach`→`cdp_detach`），复用现有 daemon-WS client；与 `chrome_network_debugger_*` 互斥门。
  - 新帧：`cdp_attach`/`cdp_attached`/`cdp_command`/`cdp_result`/`cdp_event`/`cdp_detach`。
  - cdp-mcp patch（见 §5）。
- **Phase 2 — 稳定性（3–5 天）**：detach/reconnect 闭环、`protocolTimeout` 收紧、banner/DevTools 互斥提示。
- **Phase 3 — 多 tab（5–10 天，按需）**：`list_pages`/`new_page`/`select_page` → `chrome.tabs` + 每 tab 一条 transport 多路复用；若需 `--browserUrl` 再补 `GET /json/version`。

每个 Phase 独立可回退到 Plan A；Phase 1 的 daemon 合成层 + 扩展全 domain 透传对 Plan A 也是底座（A 的工具实现也要 sendCommand 透传），沉没成本可控。

## 7. 风险

| 风险                                           | 严重度   | 缓解                                                                           |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| createCDPSession 墙（cdp-mcp 启动即挂）        | 阻断     | patch §5；Phase 0 先证实                                                       |
| ExtensionTransport 无 onDetach                 | 高       | 扩展补 `onDetach`→`cdp_detach`，daemon 合成 `detachedFromTarget`+onclose       |
| 单 tab 单 debugger 互斥                        | 高       | 与 `chrome_network_debugger_*` 互斥门                                          |
| MV3 SW idle teardown                           | 已证伪   | 118+ 保活 + 116+ WS 流量，无需 keepalive                                       |
| 5 分钟单请求硬上限                             | 中       | puppeteer 180s 先报错；长工具延后/禁用                                         |
| 调试 banner / DevTools 互斥                    | 中(UX)   | onDetach 重连 + 用户提示                                                       |
| 受管 Chrome 策略 `DeveloperToolsAvailability`  | 中(部署) | 部署前核查策略允许 chrome.debugger（force-installed 扩展 114+ 默认禁，需值 1） |
| 大 payload(截图/getResponseBody) vs maxPayload | 中       | `/cdp` 抬高 maxPayload 或分块                                                  |
| puppeteer 版本漂移                             | 低       | pin cdp-mcp 1.4.0 + puppeteer-core 25.2.0                                      |

**回退**：Phase 0 失败 → 放弃 C 回 A；Phase 1 失败 → 回 A（合成层/透传可作 A 底座）；Phase 2/3 失败 → 退守单 tab 只读快照/点击形态，仍省大量工具实现。

## 8. 建议

**C 值得做，但：① 走 patch 路线，把「零改造复用」从目标删掉（已被源码钉死）；② 先做 Phase 0 半天 spike。** spike 通过后 C 相比 A 净收益明确（page 级工具一次性接管），代价是维护一个 cdp-mcp patch + detach 胶水（A 没有的长期负担，决策时算进）。若 spike 显示受管策略普遍禁 `chrome.debugger`，则回 A。
