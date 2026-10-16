# K2 私有 Hosted attachment 与文本组合

[English](2026-10-08-k2-private-hosted-attachment.md) | [简体中文](2026-10-08-k2-private-hosted-attachment.zh-CN.md)

状态：已实现的私有前置能力；本地验证绑定基线
`85e7795c002439c5731e6a1c0eb1636d2f43069f` 加本批次。
关联 #12380、#13395 和 Draft #13526。这是仅供 operator 使用的 K2 前置能力，
不代表 CSI 文件、retirement 或公开 profile 选择已通过验收。

## 问题与当前状态

私有 operator 已能解析原已提交 Session、准备原 binding 并安装原 context。
原 native SQL 已接纳封闭 CSI genesis、首次 activation 和有界流式文本 grammar。
本批次之前，Hosted 进程尚无串联这些能力的生产调用方。普通 Hosted open/load
会创建更宽的
definition、接管 activation，并在打开失败时 seal HTTP writer。通用工具 runner
还可能释放 Runtime。这些生命周期语义不能持有本私有 Session。

## 目标与边界

使用原 Runtime Broker、SQL store、HMAC issuer 和文本 runner，将一个已提交的
私有 Session 接入当前经过认证的 Hosted boot。保持 writer generation 1 和
activation epoch 1。不替换原请求，不创建第二 Session，不 load 已有 native
owner，不接管新 boot，也不通过错误清理释放 ownership。

公开 Spring/Hosted CSI 选择、工具、deadline、普通生命周期、rewind、hooks、MCP、
Runtime continuation/cancel、物理 writer 终止、NodeUnpublish、DRAINED/RELEASED
和安全卷复用继续关闭。文件执行以及完整 MySQL/当前集群验收矩阵属于后续工作。
一次本地 attachment 成功不等于完整 K2 验收。

## 可信启动与生产方

`QWEN_HOSTED_CSI_SESSION_STORE_URL` 由 `runQwenServe` 在启动时读取一次，通过
`ServeOptions` 传递并由 server 的私有注册器消费。仅在经过认证的 loopback
`hosted-harness` 模式且同时配置 Runtime Broker URL/token 时允许使用。Store URL
必须使用 HTTPS 或 loopback HTTP，禁止 userinfo、query 和 fragment。不增加公开
CLI profile 选择或请求 body 的 URL 覆盖。lease 固定为 60000 ms。

现有 CSI classifier 增加 `text <reviewed-runtime-json> <text-request-json>`。
Java operator 在发送任何 Hosted 请求前复用严格原请求读取与原 SQL 解析。
可信启动凭据包括 `K2_HOSTED_URL`、`K2_HOSTED_TOKEN`、
`QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` 和
`QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY`。绑定的原
`WriterCredentialPolicy` 为解析后的 tenant、workspace 和 Session 签发 token。
不发送 binding key。现有 Hosted capability negotiation 提供当前 boot ID，
不调用普通 create/load。

文本文件恰好包含 `promptId` 和 `text`。限制文件大小和文本长度；要求规范 UUID
及非空文本。operator 失败只输出不含凭据的通用诊断。operator 仅关闭自己的 HTTP
client，不关闭远端 attachment 或原 Runtime。
生产方保留可取消的 HTTP exchange，在 30 秒本地等待结束时取消它，包括响应 body
不完整的情况。[JDK 21 取消契约](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/java/net/http/HttpClient.html)
只提供尽力进行的本地清理，不证明远端操作已经停止。

## 原 Runtime 回读

仅 CSI profile 的现有 acquire 响应增加 `scope.canonicalCwd` 与
`scope.isolationClass`，均来自已获准的原 Runtime Session。协议版本仍为 1，
普通响应保持兼容。专用 Hosted consumer 将原 Session UUID 同时用作 Harness
和 Runtime UUID，固定 `turnKind: bootstrap`。要求私有 capability digest、匹配
tenant/workspace、session isolation、规范 Linux 绝对 cwd 和原 binding
generation 1。Workspace generation 保留原持久值。

响应只回读当前原 scope，不是 Store 凭据或文件 grant。consumer 保存返回的
binding、cwd 和完整 scope，并在后续每次操作中比较。SQL 独立地使用当前原
authority 限制每次 native commit。禁止回退到 primary cwd。
operator 必须先通过现有经过认证的 Broker 入口将原 Runtime warm 到 READY。
attachment 不隐式 warm 或 release；可信 Store URL 必须指向该原 SQL 部署。
提供部署 base，例如 `http://127.0.0.1:8081`；HTTP client 会附加
`/internal/managed-session-store/v1`。

## 私有路由与 ownership

所有路由位于 `/session/:id/internal-csi`，继承 protocol/boot middleware，并
额外要求 primary listener 上已验证的 bearer。路由属于 live-session-owner
作用域；store 操作始终留在解析后的 Session。未知、普通、打开中、失败、blocked
或 stopped owner 均不得回退到普通或 primary runtime。

| 路由              | 行为                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST .../attach` | 封闭 body `{tenantId, workspaceId, writerToken}`；当前 Broker admission；仅创建 native owner；同 boot 的成功精确重试返回原 owner。                            |
| `POST .../text`   | 封闭 body `{promptId, text}`；保留一个本地 turn，重新检查当前 authority，提交 input 并运行实际 settled-history 文本；精确重试等待/返回原 turn，变更文本冲突。 |
| `GET .../history` | 通过当前 admission 后投影原 sink；返回 native transcript，不是 CSI 文件历史或 restore grant。                                                                 |

私有 owner 使用独立 Map。初始化在第一个异步操作前保留 UUID。普通和私有 Map
对同一 UUID 互斥，包括 UUID 大小写别名。在任何 store I/O 前阻止普通路由访问
已保留的私有 UUID；普通注册器仅向该 gate 暴露实际 ownership predicate。
其他私有子路由关闭。认证本身不授权生命周期或工具操作。

## Native 组合与文本

owner 直接组合现有 HTTP journal、resource store、
`LocalManagedSessionAuthority` 和 `ManagedSessionRecordSink`。仅发布 definition
`{engine: managed, sessionId, toolProfile: csi-files-retirement/1}` 与 root
`{cwd: brokerCanonicalCwd}`，使用 `requireNew: true` 打开，并将当前 Hosted boot
用作 worker ID 安装首次 activation。在 genesis 前验证 writer generation 1，
在暴露 owner 前验证 activation epoch 1。通用 ManagedSession 的 release、
replacement 和 close 拒绝；只有私有 owner 能停止本地活动。

文本采用原 `managed-input` 数组和 `managed-admission` digest、source 为
`hosted-harness` 的 `submitInput`、无 deadline，以及真实 `runHostedHarnessTurn`
的 `historyMode: settled`。不提供通用 ToolTurn、hooks 或 primary workspace
context。runner 产生原 checkpoint、model attempts、deltas/retractions、完整
assistant Parts 和 settlement。pending 或结果不确定的 native input 阻止新
prompt。已 settle 的模型错误保留真实 native settlement，之后可接受新 prompt。

## 失败与关闭

任何部分成功或结果不确定的初始化均变为不可自动恢复的 failed owner。停止本地
续租，但不重试 genesis、不安装另一 activation、不 seal writer、不释放 Runtime，
也不删除持久 ownership。成功 attachment 的重试仍须通过当前 admission 和 writer
检查；Map 不是 authority grant。

HTTP stores 增加 `stopLocal()`：永久本地 fence，不远端 seal。清除 timer，阻止
手动/定时续租以及重新安装 timer，并等待已经进入的 renewal promise。
保留 staged resources。普通 `close()` 继续 seal。私有 owner 独立地停止并等待
activation renewal，阻止新请求，中止自己的 active model，等待已进入的操作和
初始化，并在本地停止 HTTP store。standalone server drain 和真实
`runQwenServe` host drain 均消费同一个 closure。进程关闭不是 CSI release receipt。

## 文件与决策

修改私有 Hosted 模块及测试；serve 启动、options、profile 校验、server 和关闭；
普通注册器的 ownership predicate；HTTP store 的本地停止接口及测试；原 Broker
acquire 回读及测试；Java operator 文本入口及测试；以及本双语设计。普通 session
assembly 和 Core 工具 profile 定义无需新增 option。本功能涉及 core/跨包
基础设施，发布前需要 maintainer review。

## 验证与验收

首先记录全局 CLI 元数据和既有 build 的私有路由 404/公开 selector 拒绝。
独立验证随后使用原 CREATE/Broker context setup，让真实 Java 文本生产方经过
认证 Hosted HTTP 和原 SQL HTTP store。观察两轮流式文本、精确 genesis、
writer/activation generation 1、当前 cwd、native checkpoint/attempt/delta/Parts/
history 以及 prompt 精确重试。

阴性控制覆盖缺失/错误 bearer、secondary listener、错误 boot、HMAC、scope、
普通 owner、cwd/URL/profile 注入、不匹配 acquire 回读、并发 prompt、丢失响应、
部分初始化、新 boot、acquire 与 commit 之间 retirement、普通 release/文件路由
以及本地停止时在途续租。确认没有远端 seal、release 或 delete。明确 synthetic
Kubernetes/context receipt、H2、打包启动 seam 和真实模型边界。固定输入、原始
结果、来源/清理证据以及实际提交字节。完成 build、typecheck、bundle、focused
tests、静态检查、lint 和两次完整审查后发布到同一个 Draft PR。

## 已记录的本地结果

独立验证针对十七文件 candidate 完成十一组有界窗口。实际 Java text 入口、最终
Hosted bundle 与原 SQL Controller/事务 Store 串联了两轮流式文本、精确重试、
settled native history、工具调用拒绝及其后的成功文本。新错误 HMAC 与 owner/scope
冲突回滚；retirement 与 genesis 竞争时拒绝 native commit。丢失一次 genesis
响应通过精确重放恢复，三次 receipt 全部丢失时留下结果不确定的 sticky owner。
真实 activation renewal 被挂起时，关闭等待其完成且不远端 seal/release。

原部分响应超时缺陷已复现并修复。修后 producer 在约 30.12 秒超时，30.35 秒退出，
早于 receiver 释放不完整响应。独立本地停止与 secondary listener 组件也通过，
fixture grants 与 tagged HTTP 认证仅作为对应组件资格。

H2、synthetic Kubernetes/context setup、MockMvc-to-HTTP SQL adapter 和自有
确定性 OpenAI SSE provider 是验证 seam，不证明 MySQL 锁、完整部署 Agent
服务、真实模型、Linux/CSI 或云上行为。自有测试资源均已清理，冻结输入零差异。
六个 setup/期待失败窗口及一项清理审计分类保留为诊断。报告只绑定该 candidate，
不覆盖后续 main 合并或完整 K2 验收。

## 未完成工作

本批次保留私有文件/publication/tool grant 组合、聚合 retirement、物理 writer/
CSI unpublish 证明、重启恢复、公开选择、MySQL RC/warmed-RR 和当前云上验收。
实现后续层时必须复用原 predicates；缓存 context、transcript、receipt 或 CI
绿灯均不能替代其 authority。
