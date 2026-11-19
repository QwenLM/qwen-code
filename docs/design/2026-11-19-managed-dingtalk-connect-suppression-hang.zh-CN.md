# 托管钉钉：终结连接路径上的 console 抑制挂死

[English](2026-11-19-managed-dingtalk-connect-suppression-hang.md)

- 状态：提案
- 跟踪：#17173（由 #17136 第 11 轮评审延期）
- 相关：#17691 已落地同批的重连仲裁项

## 问题

托管钉钉流在 SDK 的 connect promise 未落定期间，**进程级**静音 `console.log`。SDK 的端点发现没有任何超时，因此一个「接受连接但永不答复」的服务端会让整个进程在尝试早已放弃之后仍然保持静音。

尝试预算会 reject，所以适配器不会无限等待：首连把失败上报给运维，之后的连接则重新排期。无论哪种， CLI 里其余所有 `console.log` 都被静音，而且逐帧的抑制作用域也再也无法恢复日志，因为它们共用同一个深度计数器。

## 现状

`withConnectLoggingSuppressed`（`packages/channels/dingtalk/src/connect-logging.ts`）在深度 0→1 时把 `console.log` 换成空函数，在 1→0 时还原；还原写在 `finally` 里，只有被包裹的 promise 落定才会执行。`withConsoleLogSuppressedSync` 共用该计数器，使得连接途中到达的帧不会提前恢复日志。

`managed-dingtalk-deps.ts` 的 `attempt()` 用该 helper 包裹 `sdkConnect`，另外武装一个 20 秒预算。预算 reject 的是尝试，**不会让 `sdkConnect` 落定**，因此那个 `finally` 永不执行。

SDK（`dingtalk-stream-sdk-nodejs` 2.0.4，`dist/client.mjs`）在连接路径上恰好发出两处 `console.log`：

| 位置                                | 时机                                                    | 载荷                               |
| ----------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| `:84` `console.log(this.config)`    | **`getEndpoint()` 入口处同步执行**，在首个 `await` 之前 | 解析后的 config，含 `clientSecret` |
| `:107` `console.log("res.data", …)` | 网关 POST 落定之后                                      | `endpoint` + `ticket`              |

`getEndpoint()` 先 `axios.get(gettoken)` 再 `axios({POST connections/open})`，两者都没有超时或中止信号。`_connect()` 完全不发 `console.log`——它的诊断走 `printDebug`（受 wrapper 已置 `false` 的 `debug` 开关门控）或 `console.warn`/`console.error`，而抑制从未覆盖后两者。

也就是说，这个无界作用域的存在，只是为了覆盖一处同步日志，以及一处时机由无界 HTTP 调用决定的日志。

## 备选方案

| 方案                                            | 消除挂死 | 保住凭据守卫                                                                    | 代价                                                |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| 尝试预算到期即释放抑制                          | 是       | **否**——迟到的 POST 落定随后会打印 `endpoint`/`ticket`                          | 小                                                  |
| 只把抑制作用域收窄到同步前缀                    | 是       | **否**——同样的迟到日志泄露                                                      | 小                                                  |
| 改静音为过滤，丢弃 SDK 形状的日志               | 是       | 更弱：形状 denylist 对未来的 SDK 日志敞开，正是 helper 注释已记录的那条反对理由 | 中                                                  |
| 用按 URL 过滤的请求拦截器中止 SDK 的 axios 调用 | 是       | 是                                                                              | 全局 axios 改动，与 legacy 频道及所有其他消费方共享 |
| **自持端点发现：有界、可中止、静默**            | 是       | 是——根本不打印                                                                  | 复制 SDK 的发现契约                                 |

## 决定

在托管路径上自持端点发现。用一份有界、可中止、静默的实现替换实例上的 `getEndpoint`，使连接路径不再发出任何 `console.log`，因而完全不需要抑制作用域。

这是通过**移除成因**而非缩短静音来消除挂死，同时也取消了尝试所放弃的那个请求——这是仅靠预算做不到的。

两个上界**不是叠加的**。`attempt()` 在调用 SDK connect **之前**就武装了 20 秒定时器，而该 connect 会 await 发现，因此一个时钟同时覆盖发现与 wss 升级。所以发现的中止**共用尝试的 horizon**，而不是另取一个更短的：更短的上界会削减发现在预算下本来就有的窗口，两次发现调用合法地耗时超过那个更短上界的租户，会从「原本能成功」变成「每个尝试都失败」。同一 horizon 上中止新增的是**对被放弃请求的取消**，而不是第二个更早的期限。

发现契约很小且稳定：两个 URL、两个查询名、四个载荷键、两个 header。每一项都由一条读取 SDK 已发布源码的测试钉在钉住的 SDK 版本上，因此升级若改名其中任何一个都会让套件变红，而不是让发现继续发送旧名字。

## 改动

- `packages/channels/dingtalk/src/managed-dingtalk-deps.ts`
  - 新增有界端点发现：用 `fetch` 与 `AbortSignal` 执行 token GET 与网关 POST，沿用本包 webhook 发送已有的形态。它写入 `config.access_token`、`config.endpoint` 与私有的 `dw_url`，且不打印任何东西。
  - 把它装到已构造的 client 上取代 SDK 的 `getEndpoint`，SDK 自身的 `connect()` → `_connect()` 序列保持不变。
  - 从 attempt 中去掉 `withConnectLoggingSuppressed`。逐帧的 `withConsoleLogSuppressedSync` 作用域保留。
- `packages/channels/dingtalk/src/connect-logging.ts` —— 仅改头注释，无行为变化：该异步 helper 现在只属于 legacy 频道。它自身的暴露面记在下面的范围外。
- 测试：发现见证（请求形状、中止、静默、字段赋值）、挂死见证（永不答复的发现让 `console.log` 在尝试预算到期后仍保持原样），以及对 SDK 源码的契约钉。

## 范围边界

- legacy `DingtalkAdapter` 的连接路径保留现有 helper，因此也保留同样的挂死。它是另一个面、有自己的连接管理器；在此一并改动会让影响面翻倍。本 PR 范围外，已作为独立遗留条目记录在 #17173。
- 不改重连仲裁、尝试预算数值、心跳回收与台账。
- 不改帧抑制作用域与深度计数器语义。

## 出口

把发现从 SDK 的 axios 换成 `fetch`，会改变它遵循哪些代理设置，因此这是一处**刻意选择**，不是「保持原行为」。

`resolveProxy` 为频道进程安装的是**全局** undici dispatcher。`fetch` 会继承它，axios 从来不会。若放任其隐式生效，同一个 `settings.proxy` 就会因「谁装了 dispatcher」而意味着不同出口——CLI 会装，daemon worker 未必装；而仅有环境变量代理时方向又会反过来，因为 axios 读那些变量、`fetch` 不读。

因此发现**显式**接收已解析的代理，两条腿都走一个逐次调用、用完即销毁的 `EnvHttpProxyAgent`，与 webhook 发送完全一致。出口不再依赖环境的全局状态，本适配器的两条 HTTP 路径也就此一致。wss 升级不变、仍不走代理，所以「只有代理出口」的部署本来就无法端到端完成连接——本改动既不制造该限制，也不修复它。

## 验收

- 永不答复的发现让进程的 `console.log` 保持未被修改——尝试期间与预算到期之后皆然。
- 任何连接路径结局都不打印解析后的 config 或网关响应，包括预算到期后的迟到落定。
- 发现在尝试的 horizon 上带一个真实的中止期限——由 spy 超时构造器钉住，因此「永不中止的信号」会让套件变红——且发现在预算下原有的窗口不被削减。
- 移除该覆写、或换回 SDK 自己的 `getEndpoint`，会让见证变红。
