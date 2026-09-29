# Hosted 前台 Shell 工具回合

[English](2026-09-27-hosted-shell-tool-turn.md) | [简体中文](2026-09-27-hosted-shell-tool-turn.zh-CN.md)

状态：已在显式私有 profile 后实现。基于 #12831 和已合并的 O1c #12821。

## 问题与范围

Hosted 已能通过保存的 Workspace 执行 Read、Write 和 Edit，但尚不能执行 Shell。
O1c 能捕获前台进程管道，并在本地 Session writer 下接纳完整输出。Hosted 使用 HTTP
Session Store，其普通资源发布只暂存在内存，直到 journal 事务才提交，且 inline
上限为 64 KiB。直接将该存储注入 O1c 会错误确认持久化，并丢失未引用的 page。

新增显式选择的 `hosted-workspace-shell/1` profile，包含现有文件工具和前台
`run_shell_command`。默认无工具模式与 `hosted-workspace-files/1` 保持原行为。
首个桥接支持现有同主机进程 provisioner；不增加公共下载、对象存储、PTY/后台任务、
自动垃圾回收、任意远端 provisioner，或不确定执行的重启/重放。

## 所有权与传输

Hosted Session owner 在
`http://127.0.0.1:<port>/internal/hosted-shell-publisher/v1`
开启临时 loopback 发布器，使用随机 capability。取得运行时后，新的私有 Broker
注册操作将描述符安装到原 Runtime Session，并返回 binding generation。worker
只接收规范的 loopback URL、拒绝重定向，capability 只保存在内存；journal 引用和
模型参数均不包含它。SQL writer token 不会传给 worker。

worker 先通过私有 owner listener 准备捕获。其原始管道 sink 将有界 write/finish/finalize 请求转发给 owner。每条流的
write 和 finish 串行处理，包括 Node 在进程退出时恢复暂停管道而产生的重叠回调。owner
复用 `LocalShellResultCapture` 的 1 MiB 分段、有界 page、双流背压与最终 manifest。
原始 write 回复确认有界捕获缓冲，只有 segment publication 回复确认持久字节。
丢失的原始 write 回复不重试。任何不确定的 write 或 finish 都不可逆地标记捕获
失败，以有界内存排空物理进程，并禁止完整回执。finalize 保留真实退出/取消结果。
面向模型的文本预览另限 8 KiB UTF-8，使转义后的 JSON 和回执元数据满足现有
64 KiB 历史资源限制。长预览保留最多 2 KiB 头部，其余预算用于截断标记和尾部，
切点只落在 UTF-8 字符边界，以保留末尾的失败摘要和退出状态。这里的尾部来自
有界的 64 KiB 进程缓冲；从持久捕获中读取更大输出的真正尾部仍是后续工作。
原始捕获跳过普通临时文件输出截断器：预览不能冒充完整的
本地文件。模型文本截断时明确显示执行状态，并说明完整输出保存在 Session 结果中，
不推荐不可访问的 worker 路径。

| 路由                                   | 所有者与检查                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Broker publisher 注册                  | 原选定 Runtime Session、binding、lease 和 Workspace 所有权                                         |
| worker publisher 注册                  | 已认证的选定运行时；具名 Runtime Session 的不可变注册                                              |
| publisher prepare                      | 活跃 Session owner；读取 checkpoint 和参数后重新检查 writer 与 activation，并核验原始执行映射      |
| publisher write/finish/finalize/accept | 活跃 Session owner；capability、activation、已注册原始执行、运行时/模型调用映射和 capture identity |
| 持久输出发布                           | 持久 Session；tenant、Workspace、writer token、writer generation 和未过期租约                      |
| Broker start/status/cancel/ACK         | 原始执行与保存的协议选择；不回退 v2                                                                |

## 持久输出存储

基于现有 SQL 资源表新增受 writer fencing 保护的窄资源发布操作。仅允许工具结果
content（最多 1 MiB）、page（256 KiB）和 manifest（64 KiB）。不增加普通 inline
发布和 journal 事务的限制。成功回复必须在 SQL 事务提交之后返回。稳定资源 ID
不可变且幂等；相同 ID 携带不同字节或元数据必须冲突。

Session 持有的顺序分段适配器将 capture/stream/ordinal 映射到确定性资源 ID，
自行计算长度和 SHA-256，核验精确的已接收前缀后持久保存不可变 seal。它是前台
producer 适配器，不是任意乱序 O1a 上传实现；只接受 stdout/stderr 和连续 ordinal。
活跃上传游标以有界内存保存，owner 丢失后不恢复上传。page 和 manifest 也立即
持久化，避免 staged resource 引用闭包问题。所有生产进程退出后，新的 reader 仍能
校验保留的 manifest、page、seal 和 segment 字节。资源随 Session 保留，ACK 不
删除数据。仅发布但未接纳不能推进模型；遗留字节等待后续 Session 清理能力。

## 身份、接纳与模型历史

保留两种摘要：现有精确 `payloadJson` 字节摘要保护 Broker 延迟 start；
`managedToolDigest(input)` 标识 Tool v3 参数。持久保存模型调用 ID、唯一 worker
调用 ID、执行 ID、input digest 和显式 v3 选择。Shell 的 `tool.intent.argsRef`
保存真实 input；route 资源保留 Broker payload。owner 在首次副作用之前，对照已
覆盖的 `await_runtime` checkpoint 核验此映射。Hosted 显式将 checkpoint 绑定到
当前 turn、prompt 和提交 checkpoint 的 activation，包括 detach/load 或 Harness
重启之后；尚未结束的回合不能改名。runtime binding 的
`invocationBindingId` 保存 worker 调用 ID，tool item 保留模型调用 ID。异步读取
checkpoint/参数后，prepare 再次检查 writer 和 activation；writer 检查在 await
返回后也重新核验 activation。

将 O1c 接纳逻辑提取为共享 Session 实现。本地 wrapper 保留现有 lease/root 校验
和自动推进 checkpoint；Hosted 使用已有 HTTP writer 和 activation，只在提交
面向模型的结果之后推进。提交 `tool.receipt` 前，以有界 range 重读完整输出，核验
原始身份与流摘要。回执 event factory 在 authority 提交队列内再次核验原始
activation，因此输出验证期间发生替换时，旧 owner 不能接纳结果。完整捕获得到 `committed`；partial/unavailable 得到 `blocked`，
保留物理结果并停止回合。

顺序为：acquire/register，持久保存 assistant 和 intent/checkpoint，执行，持久
捕获，持久回执，模型结果，checkpoint resolution，精确 ACK，下一轮推理，结果
消费，release。worker 的远端 accept 返回同一持久 Session 回执，后续 ACK 仅重放
它。丢失 execute 回复时，仅以原 v3 reference 有界查证状态。状态未知或缺少接纳
时绝不再次发起 Shell 副作用。回执回复丢失时，可用完全相同 candidate 重放已记录
回执。新 activation 继续拒绝旧回合尚未解决的工具调用。

已接纳的 Shell 结果必须能放进完整序列化后的历史记录。如果违反此约束，保留
恢复阻塞的所有权，不提交省略响应，也不确认结果：修改历史却复用已接纳的
outcome 引用会导致二者不一致。文件工具的超限结果继续使用有界的省略响应。

## 生命周期与故障处理

Runtime 预热仍与推理并行。仅文件工具或纯文本回合不需要 Shell 发布器。Shell 参数
拒绝后台执行，并使用保存的 Workspace 目录。非法 Shell 参数在获取运行时或
派发之前返回持久化的函数错误。若任意 Shell 调用非法，整批拒绝，其他调用分别
明确报告未执行；模型可以在同一回合修正整批参数。拒绝响应无法持久化时保留
恢复阻塞。发布器不可用时，在 spawn 前拒绝。
发布失败、writer 丢失、执行未知、回执/历史/ACK 失败或取消未证实，均保留恢复阻塞
的所有权。启动前取消保持 `not_started` 和 null capture；启动后需要物理进程结果
及捕获接纳。关闭 Session writer 前，停止发布器新请求并排空在途操作。完成的回合
关闭私有 listener，保留输出数据。

## 实现与验证

涉及层次：core HTTP resource client、共享 Shell 接纳与分段适配器；CLI Hosted
profile、publisher 和 worker proxy；Java Session Store、Broker 原执行路由与
Workspace transport。不新增或重定向普通 daemon 路由。

聚焦测试覆盖不可变发布与过期 writer、segment prefix/seal 完整性、跨 Session/
activation 身份、原始回复丢失、先接纳后历史、精确 ACK、取消及现有文件/无工具
模式回归。另覆盖 UTF-8 头尾预览、整批拒绝后的恢复、publisher bearer 鉴权、
正常和失败回合结束后的 listener 关闭，以及最坏 JSON 转义下已接纳结果的历史
上限。真实进程测试通过生产 Java Broker 和 SQL Store 运行打包的 Harness 与
worker，使用 Harness decoy 核验所选 Workspace，产生 100 MiB 并独立核验 stdout/
stderr 摘要和尾部，然后在生产进程关闭后重读保留输出。故障测试要求副作用最多
一次，且不得发出下一次模型请求。评审前完成 build、typecheck、bundle 和连续两轮
干净的全量 diff 审计。全局 CLI 基线另行记录；缺少其私有 Hosted 路由不能当成
功能验证通过。

验收必须证明实际跨进程完整捕获与持久接纳，不能仅凭 v3 HTTP 回复。没有未决产品
选择；公共 artifact 访问、分布式存储和恢复仍属后续工作。
单次调用/Session 存储配额和降低 writer lease 续租频率也保留为后续工作；本次不
改变持久发布和 fencing 机制。

本地验证使用 macOS、Node.js 22、Java 21、真实进程和 MySQL 模式的 H2。
六 Workspace fixture 验证完整 100 MiB 输出、SQL 发布失败、原始 write/start
回复丢失、取消，以及生产进程退出后的新 reader。未验证真实 MySQL 部署、Windows、
Linux 或真实模型服务。
