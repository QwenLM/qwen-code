# Web Shell BTW 流式输出

[English](web-shell-btw-streaming.md) | [简体中文](web-shell-btw-streaming.zh-CN.md)

## 问题与当前行为

Web Shell 等待完整 JSON BTW 答案，并在 30 秒后超时。
子进程和 bridge 还分别限制 55/60 秒。模型已经分块输出，但内部累积后才返回。
用户需要及时看到部分答案，并在网络短暂断开后简单恢复。

## 方案

保持原有 `POST /session/:id/btw` 接口及行为不变。新增
`POST /session/:id/btw/stream`，接收 `question`、客户端生成的 `requestId`
及可选 `resume` 标记。接口通过 SSE 返回答案快照以及终结的 `done` 或 `error` 事件。
每个答案快照包含已累积的全文，UI 替换而非追加答案，避免重连后重复文本。
中途快照保留空白；最终快照裁去首尾空白，与既有 JSON BTW 结果一致。
重连复用同一请求 ID，并收到最新快照。恢复请求若已无缓存，返回 410，绝不重新调用模型。
同一 ID 携带不同问题会被拒绝。

daemon 每个请求只保留一个答案字符串，不保存事件日志。网络断开仅移除订阅者，
生成继续。显式 `DELETE /session/:id/btw/stream/:requestId` 取消生成；
若取消先于启动到达，短期保留取消标记，防止随后启动。
新请求的 daemon 总时限为 300 秒，子进程为 305 秒，bridge 为 310 秒，
让 daemon 先返回 `btw_timeout`，上游随后完成清理。若 BTW bridge 自身时限触发，
也会尽力取消该次生成，不取消主任务。已完成请求和取消标记最多保留 60 秒。
每个 runtime 最多保留 32 个请求；满额时淘汰最早登记的终态条目，全部活跃时返回 429。
答案上限为 1 MiB，不能为了接受新请求而淘汰活跃请求。
SSE 复用现有的 15 秒心跳和支持背压的写入方法。

SDK 对网络错误和可重试 HTTP 响应进行有上限的退避重连，重连预算为 60 秒。
离线预算到期时不再启动新的 POST，抛出最近的失败，并仍尽力发送显式 DELETE。
在观察到成功 HTTP 响应之前，重试复用请求 ID，不设置 `resume`；即使响应头丢失，
存活 daemon 的缓存仍会对已接受的请求去重。观察到成功响应后，重试设置 `resume: true`，
缓存丢失时返回 410，避免重新生成。这不保证跨 daemon 重启去重。
即使主会话使用 ACP HTTP/WS，也使用原生 REST fetch。
取消会中断重连等待并显式发送 DELETE。应用错误和过期请求直接结束。
Web Shell 仅对该流绕过普通 action 的 30 秒总时限。
UI 消费只包含答案和终态的本地快照，不伪造协议请求 ID，并要求流以终态结束。
流失败时保留已显示的部分文本，通过现有错误通知展示服务端错误信息。
SSE 和 HTTP 错误的服务端错误码均保存在 notice 元数据中；toast 展示错误信息而非机器码。

BTW 面板默认跟随最新内容，也覆盖 Markdown 延迟布局变化。用户向上滚动时暂停跟随，
回到距底部两像素以内时恢复。每个新问题都重新启用跟随。

daemon 仅在所有已注册 runtime 的 bridge 都实现流式方法时声明
`session_btw_stream`；Qwen daemon 的初始启动窗口也声明相同标识。
Web Shell 每次 BTW 都先检查这一独立标识：标识缺失或能力信息尚未取得时，
只调用既有 JSON 请求并保留原来的 30 秒 action 时限，将结果转换为 UI 的完成快照。
流式请求一旦启动，失败时绝不再发起第二次 JSON 模型请求。
SDK 流式接口调用方也必须预检同一 feature。

## 决策与范围

BTW 不经过主 agent 共享且支持回放的会话事件流，避免影响 transcript 和其他客户端。
复用现有请求级生成队列、通知、取消、SSE 工具，以及 fork 查询的上下文和工具限制。
内部增加 BTW 生成用途，并在 cache-path fork helper 增加文本回调；旧 BTW 方法继续原有路径。
无需事件日志、持久化存储、传输层重构、新依赖或 daemon 重启恢复。
流式 BTW 保留既有 SSH workspace 限制，普通无状态生成保留原来的 SSH 行为。

两个新路由均属于 live-session-owner 范围。每次启动、重连及取消都经过现有 owner
解析和 mutation/trust 门禁。内存状态按解析后的 bridge 实例、session、client 和请求 ID
隔离，不能跨 workspace，也不能回退到主 runtime。正在执行的 side request 计入本地活动，
避免空闲回收中断断线期间的生成；生成结束时释放占用。这有意覆盖所有既有 side request，
包括旧 JSON BTW、recap、无状态生成、fork 启动及会启动工作的 workflow/goal 操作。
它们待完成时也阻止要求空闲的 bridge 关闭。旧 JSON 路由的门禁与时限保持不变，
显式 bridge 关闭仍按既有规则执行。共享归档门禁仅覆盖校验及登记，
不覆盖完整生成周期，确保订阅者断线后主动关闭会话及 daemon 退出仍能中止待完成工作。
已记录的客户端在 detach 后
仍可取消自己的缓存请求；创建未知请求的取消标记仍要求当前会话成员身份。
用户取消、切换 session/workspace 或发起新 BTW 时，保留原有旧结果防护，
不得取消主任务或向主对话追加内容。

涉及范围：core fork helper、ACP bridge 请求生成、CLI ACP handler 及 owner 路由/请求快照、
SDK BTW 流、Web Shell action/答案面板/浏览器 fixture，以及针对性的单元和浏览器测试。

## 验证与验收标准

- 保持旧 JSON 响应、时限和现有通用生成协议；旧 BTW 和通用生成一致使用 side request 空闲保护。
- 如实声明流式能力；缺少 feature 或 capabilities 时仅走 JSON，有标识时仅走 SSE，
  流失败后不得再重试 JSON。
- 完成前显示部分答案，支持超过 30 秒的响应；真实 HTTP 原连接及恢复连接
  均须在释放模型完成门之前收到部分内容。
- 默认跟随输出，向上阅读时暂停，回到底部恢复，新问题重置跟随；终态失败保留部分答案。
- BTW 运行时保持主任务执行和 transcript 隔离。
- 断线重连返回最新答案，不重复调用模型或拼接文本。
- 响应头到达前的网络失败可重试，不误报 410 或重复存活请求的模型调用；
  已接受请求的恢复若过期则拒绝，同时拒绝请求 ID 冲突。
- 限制缓存大小及生命周期，覆盖全活跃满额、终态淘汰、精确答案大小及保留期边界。
- BTW 断线后仍在生成时，关闭会话和 daemon 退出应及时完成。
- 接收中或重连中均可取消；取消先到时不得启动生成。
- 新路由保留 owner runtime/client 隔离及输入验证。
- 运行针对性测试、build、typecheck、bundle 和浏览器验证，目视检查截图。
- 基线及验证报告区分真实 daemon/ACP 链路与模拟模型。

## 待定问题

无。daemon 重启恢复以及超过缓存保留期的长期离线恢复不在本次范围内。
