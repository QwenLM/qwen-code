# Managed 普通客户端、交互与事件投影

更新日期：2026-09-11；基于源码 `a836081466` 和三层设计 `4cacfbd0ed`。本稿细化 C05/C14/C15/C18 的 Web Shell、REST、ACP、SDK 和管理路径；是待实现设计，现有公开接口仍按[兼容映射](managed-agent-session-method-map.md)逐项保留，独立 Managed 实验页不替代普通入口。

## 1. 入口与路由归属

| 接口组                                      | 所属范围与调用链                                                              | 兼容要求                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| capabilities / daemon配置 / 共享注册表管理  | process-global；仅声明已实现能力，mutation使用其原管理owner                   | 不从一个Session的能力扩大整个daemon支持面；auth/rate limit原顺序保留                 |
| workspace列表/信任/目录服务                 | resolved selected-runtime；使用其env、FS、trust和generation                   | unknown/removed/bootstrapping/draining不能回primary；工作区管理与Session引擎选择分开 |
| new/create（含仅创建与初始prompt）          | 持久workspace内的admission，selector与paired Bridge                           | 创建仅持久身份不跑模型；初始prompt另提交；普通ID reservation/同步错误保持            |
| prompt/cancel/permission/活事件             | live-session-owner；Bridge→绑定SessionExecutor→authority/coordinator          | 不因当前请求来源更换engine；取消定位原turn/调用；旧方法可选性和返回类型保持          |
| list/title/archive/export/transcript/冷恢复 | persisted-workspace scoped；Repository/authority，必要时兼容legacycontrol传输 | Managed读取不需要Harness；老controlSlot行为不改变成新强保证；不展示Tool-onlySession  |
| fork/rewind/delete                          | 原Session维护owner，关闭/锁/版本检查后执行专项协议                            | 无执行暂停证明不修改历史；新fork有新ID，当前Session不跨engine重放                    |
| Channels/Live/Standalone/定时               | 先解析可信来源与purpose，再进入上述同一接缝                                   | 普通SDK成功不代表这些入口已迁移；各自目录锁、交付、run和父子身份保留                 |

实现位置：CLI `serve/routes/session.ts`、`serve/acp-http/dispatch.ts`、server的workspace解析及archive/list；ACP Bridge与bridgeTypes；Web Shell的DaemonClient/WorkspaceProvider/SessionView；Standalone/Live协调器。旧方法的精确返回与调用者在268项附录中列明，不另建一套Managed公共REST。

## 2. 受理、终态和物理完成

普通REST prompt仍返回已有202 `{promptId,lastEventId,eventEpoch}`，但Managed适配等待输入+唤醒的持久ACK后才响应。同步admission ticket仍先检查Session、队列、ID、workspace与用途；onPromptAdmitted/完成Promise的时机分别保留。客户端断线不等于撤销已接受输入，重复请求使用同业务ID查原结果。活会话 `POST /session/:id/prompt` 现接受 body `promptId`：相同内容返回原 turn，不同内容 409。普通 REST SSE 断开只结束订阅，不取消已接受 turn。

authority投影维护 `turnId/promptId → inputId/terminal event/physical holds`。用户正式消息只出现一次；模型流preview带attemptId且可丢弃，模型完成内容和ToolOutcomeRef提交后才合并为正式历史。内容块、tool IDs、模型切换、用量、stopReason、附件和引用保持原形状；display裁剪不修改模型恢复内容。

deadline、用户cancel和原操作实际结算可先后到达。外部已经发出的正式 turn_error/turn_complete 不再被迟到工具结果改写为另一终态；物理晚成功单独保留结果并更新原调用投影，后续执行仍受未决安全屏障约束。内部turn.settled仅一个正式终态，`pendingOwnersRef`可以非空；最后一个physical hold消失不额外触发第二次任务完成通知。

## 3. 历史、流与恢复游标

Session authority是正式事件唯一来源；Bridge live bus是有界投影缓存。订阅先读固定throughSequence快照，注册后补齐大于该位置的事件，再持续追流；按eventId去重。projection revision或Bridge eventEpoch变化时客户端重读快照，不把旧bus整数cursor直接当authoritysequence。

| 事件/投影          | 正式来源                                      | 客户端行为                                                                                      |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| user消息/排队      | input.accepted                                | 原inputId去重，发送失败可准确区分未受理与已受理后断线                                           |
| assistant/tool内容 | message.committed / tool.receipt              | 按message/call/part归并，保留并行工具ordinal；不从preview制造完整结果                           |
| 工具运行与进度     | 已提交意图/原Runtime进度                      | 展示工具名、状态和输出；进度丢失可显示缺口，不能把0字节当空闲                                   |
| 等待审批/问答      | action.changed(state=requested)及当前决策投影 | 只恢复仍pending的请求；过期、已决、被改参旧票据不可再次授权                                     |
| 用量               | model attempt正式usage与已提交累计            | 以attemptId/receipt去重；provider未提供为unknown，不使用0；重试费用保留attempt归属              |
| 终态/通知          | authority正式turn终态                         | 继续映射现有turn_complete/turn_error；不能由Artifact callback或UI idle推断完成                  |
| 恢复被阻塞         | 原调用/配置/存储的可公开原因                  | 显示“上次操作结果待确认”等可操作信息，提供查原状态/取消/另开任务，不暴露lease、secret或内部路径 |

冷历史分页沿原cursor形状，通过适配返回user/assistant/tool/Goal/artifact/压缩/分支投影。无live对象照常可读；未知格式严格恢复拒绝，展示容错不能静默写回。目录合并持久记录与活状态，以逻辑Session ID去重，worker/runtime ID仅作受控诊断。

## 4. 权限和用户问答

保留first-responder、consensus、local-only等已实现策略。`votePermission/respondToPermission`的同步boolean仍表示原协议的登记结果；最终决策持久化由内部异步仲裁门槛完成。Harness派发只消费最终decision receipt，不能据中间投票true执行工具。

Action记录包含 `requestId, kind, source, inputRevision, optionsRef, policyRevision, createdAt, expiresAt?, state, decisionRef?`。source 是封闭 union：`tool_call {sourceCallId,executionCallId}`、`automation_run {runId,occurrenceId,targetRef}`、`team_plan {teamId,requestId,childRunId,planRevision}`、`user_operation {operationId,originClientRef}`；由已认证来源选择并校验原记录，不接受模型自报 scheduler/leader 身份。旧权限工具的 sourceCallId 从 tool_call 分型投影，非工具确认不造假 call ID。Runtime工具另带原prepare/ref；纯问答不创建Runtime。重连根据authority重建action和新连接waiter，不恢复旧Promise；重复响应查原decision，冲突、改参或过期按原协议返回拒绝。新参数必须新prepare/revision和重新审批，旧版票据不可升级。

创建与决定分别校验：tool_call 由有效 Harness 经 appendExecution 请求；其余三类只由注册适配器经私有 requestAction 请求，actor/来源矩阵以[存储 §3](managed-agent-session-storage.md#3-事件-union-与生产消费链)为准。客户端没有任意创建 action 的权限，原用户操作入口由服务端适配；所有最终决定仍走 resolveAction 和原仲裁。UI 从已提交 requested 投影展示非工具确认，不依赖活 Harness、正在生成的 turn 或伪造 sourceCallId；重连/重复点击只消费原 requestId 与版本。

无客户端时保持原用途的超时/自动拒绝规则：foreground需要交互的调用等待其原deadline或授权client重连；非交互明确不支持的询问准确失败；已持久支持detachable wait时可释放Harness。legacy ACP当前无live stream的拒绝行为保留；Managed新的持久等待通过协商能力接入，不能让不支持客户端永久挂住。关闭/取消先提交取消意图，再结束原waiter；与可恢复detach分别处理。

## 5. Web Shell 状态与可操作性

普通SessionView继续使用现有组件和交互，不新增要求用户选择engine的控制。运行时有明确的生成/工具运行/等待授权状态；没有assistant内容时也能显示已接受输入和当前工作。流暂断显示重连并后台读取正式状态，不一直维持无法恢复的loading。

Send的可用性沿原普通入口的并发/排队契约：空输入、提交中的同一请求、关闭或超限准确禁用并给出原因；运行中的后续输入按原队列能力处理，不能因Managed未释放一个布尔busy永远无法发送。cancel在无活Harness而原工具仍运行时也能调用coordinator；按钮受取消状态控制，不只依赖本地streamingState。

终态到达后结束对应prompt的生成状态，保留其他prompt/后台工作的占用。terminal已发但原副作用待结算时，输入框不自动触发危险续轮；展示待确认原因和可用操作。页面重载根据持久snapshot恢复消息、审批、队列及取消状态，无需实验URL参数。

通知只消费最小 `{sessionId,promptId,outcome}`，结合原用户开关、后台/失焦状态以及站点/OS权限；重放终态不会再次通知，打开过的历史任务不补发完成提醒。父任务接受和Channels发送走各自持久outbox，不用浏览器通知完成作为业务交付证明。

## 6. 客户端版本与有限默认

定时任务由新能力 `scheduled_task_server_run_v1` 在显示 Run 入口前协商；新 Managed 任务采用服务端统一受理/派发，不能让旧客户端沿先 prompt 后登记 run 的路径重复发送。未协商的客户端仅得到该类任务只读/明确不支持的入口；legacy 任务保留旧协议。详见[自动任务与交付](managed-agent-automation.md)。

能力声明区分 `session_schema`, `durable_admission`, `durable_actions`, `harness_restore`, `runtime_receipts`, `artifact_resources`, `scheduled_task_server_run_v1`，服务器只发布实际实现且满足该workspace/config/platform组合的能力。新client可以消费增强投影，旧client仍走相同公开DTO；无法无损适配的增强操作准确unsupported，不偷偷改成legacy执行。

新默认按purpose、配置快照和平台proof选择；同一workspace可以并存legacy与Managed，旧Session沿固定owner。开关关闭只影响后续新建，保留已存在Managed authority和恢复client；不可停用它们的reader再要求旧引擎执行。发布回退必须包含新格式reader/maintenance兼容版本，或关闭旧Session执行只提供导出，不删除格式guard。

## 7. 普通入口验收

| 编号 | 场景与通过条件                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| U01  | 四处factory与Web Shell/REST/ACP/SDK create→prompt→工具→final；持久ACK、实际engine与真实物理结果对应，无实验flag                    |
| U02  | 首轮失败后继续、队列满/重复/断线/重载；Send和cancel可恢复，消息不重复，未知受理可查原ID                                            |
| U03  | ask-user/权限策略、改参、重复票、无client、换连接、close/detach竞争；无旧票据新授权，无永久孤儿waiter                              |
| U04  | preview中断、换model attempt、完整正式内容、超大媒体与慢SSE；历史及用量完整去重，未收到usage不记0                                  |
| U05  | turn terminal与物理晚成功/父接受/通知并发；单正式终态、单通知，原结果不被cancel覆盖                                                |
| U06  | cold history、archive/export、旧reader/新schema、workspace remove/replacement；不启动无关Harness，不回primary、不暴露workerSession |
| U07  | 浏览器后台/失焦和两层通知权限、完成后重开旧页面；真正新完成才通知，历史重放不通知                                                  |

本轮不运行这些产品验收。实施必须保留源码版本、普通入口请求/事件与物理证据，不能把文档矩阵或实验页面通过写成全量客户端支持。
