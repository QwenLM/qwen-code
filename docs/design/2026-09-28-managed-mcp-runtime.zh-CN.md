# Managed MCP 运行时（H1）

[English](2026-09-28-managed-mcp-runtime.md) | [简体中文](2026-09-28-managed-mcp-runtime.zh-CN.md)

状态：已实现私有配置；生产启用另行推进。本文实现 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H1，基于 `b32f261afd` 的 H0c。本次包含实际 Hosted 调用所需的前置接线。规范依据是[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)第 4、12–14 节，以及[配置设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-config-extensions.md)第 5 节。

## 问题与现有边界

H0c 能提交扩展记录，但没有 MCP 生产者。私有 Hosted Workspace 配置只执行文件工具。Broker 已支持先预留再派发、状态查询与取消，但 control transport 不能配置 MCP、读取资源或获取提示。Legacy MCP 发现还会把部分失败当成空目录；直接复用会把失败发布为成功删除全部能力。

MCP 需要独立配置与操作记录、不可变目录修订、由 Runtime 持有的连接和凭据，以及不能授权再次发送请求的未知结果。资源读取与提示获取返回的是数据，不能伪装成模型工具结果。MCP 记录不属于五种类型的 Session 任务列表。

## 范围

增加显式的私有 Hosted MCP 配置及其必要的 Broker control 链路。公开生产启用另行推进。支持 stdio、Streamable HTTP 和 SSE 连接，以及工具、资源、提示目录。SDK 反向传输必须持有原客户端租约；无法表达该租约的入口拒绝它，绝不把它转换成共享 HTTP 或 stdio 服务。

定义是 Runtime 的部署配置，按 workspace、server ID 和不可变修订选择。只有 Runtime 读取的 manifest 保存连接配方与凭据；Harness 只得到展示信息和 schema。Harness 不执行隐式 settings 或 OAuth 发现。修改连接配方必须产生新的定义修订。安装替代连接不会改变已受理操作的定义、目录或连接代数。

本次不实现 Hooks、Shell/Monitor 后台工作、子任务、Channels、自动化、公开 MCP 配置编辑器或远端自动重试，也不扩大现有普通文件工具配置。MCP control 使用独立且有大小限制的协议，与 #12868 的通用 Broker provider control 并存，各自保留校验和准入规则。

## 架构与归属

| 层                     | 职责                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Core Session authority | 提交封闭的 `mcp_configuration`、`mcp_operation` 记录及引用资源；重建修订链；签发限定范围的 grant。                                  |
| Hosted Harness         | 选择显式 MCP 配置、派发前提交 intent、使用固定目录，并在继续模型前接受物理回执。                                                    |
| Java Session 存储      | 在日志事务内校验和物化 MCP domain 修订，不发出任务事件；提供脱敏的 Session 目录。                                                   |
| Runtime Broker         | 解析已保存的 Session 和原 Runtime，检查 Workspace owner，以原身份转发 MCP control；绝不回退到 primary/default Workspace。           |
| Tool Runtime           | 装载该 workspace 允许的定义、持有 transport、执行 Session 准入与配额、固定连接/目录修订，并在该 Runtime generation 内保留调用回执。 |

所有新增私有 worker 路由都属于 live-session-owner 范围。Broker 从已认证的 Harness Session 解析路由，不接受调用者自由选择 workspace。新工作需要有效的已安装上下文与 grant。查询、取消和 drain 指向原 owner；缺失原 generation 表示未知，不意味着可以重新 attach 到别处。

观察已取得的 owner 时会重新校验持久化身份和有效 generation，无需重新获得新工作准入权限；新的副作用仍通过 Workspace 授权。如果 Broker 已重启且访问权限也已撤销，缺少进程内原 owner 上下文时仍保持阻塞，不重新开放准入。

## 记录、目录与副作用

配置与非工具操作内嵌 H0 运行块。每份配置持久保存不可变的 `runtimeSessionId`，使重新加载、查询与 drain 都指向原 owner。只有 Broker 确认释放后才将配置标记为 released；下一次连接根据已提交配置历史派生新的 Runtime Session 身份。新 Runtime Session 身份使用 `mcp-` 加 Session key 与已提交配置历史的摘要，满足 Broker/provider 的路径安全身份约束，并保留确定性重载和释放后生成新身份的语义。已有记录始终保留原 owner；不支持迁移合并前使用冒号 owner 的开发快照。其修订链没有任务投影。TypeScript/Java 共用 fixture 覆盖畸形结构、不可变身份、合法后继与终态。资源闭包包含目录、参数及原始 MCP 响应引用。

配置 intent 固定 server 定义。回执记录连接代数，以及 tools/resources/prompts 各自的发现状态（`complete`、`partial`、`failed`、`stale`）。成功的空列表是 complete。发现失败不能把先前有效的列表替换成貌似权威的空列表。目录更新只影响后续新调用。

资源或提示 intent 固定参数与 server/catalog/connection 修订。物理请求用稳定 operation ID 标识，原始响应先存为资源再提交结算。重复命令内容加入同一个操作；复用身份但内容不同会被拒绝。工具调用保留普通工具的 intent、permission/preflight 和 receipt 语义，以及原 execution 身份。审批通过后、准备执行之前，Harness 只更新 MCP grant，并持久保存更新后的输入与摘要；即使审批等待超过旧 grant 的有效期，已批准的参数与连接 pin 也保持不变。

网络发送或进程启动前必须已有提交的 intent。尚未进入 `dispatch_started` 的资源/提示 intent 可以保留原 pin 恢复首次派发，也可以在本地取消并证明从未开始；状态查询不能把这种未发送的 intent 变成未知副作用。已提交结果的重放无需重新连接 Runtime。发送后的响应失败为 `outcome_unknown`，恢复只查询原身份，重连路径不能再次发送。未发送请求可立即取消；派发后的取消延迟到原响应到达。Runtime 不发送原生取消通知，因为 SDK server 会抑制后续响应，导致结算证据永久丢失。仍记录原响应；取消绝不证明远端副作用未执行。可验证的迟到响应可以结算原调用。Runtime 丢失时，未决副作用保持阻塞。

发现期间收到的列表变更通知会使对应类别保持 stale，并发列表响应不能清除该失效信息。每次模型请求和新资源/提示命令之前，Harness 检查发现状态。未变化的目录保留修订，包括从未返回有效列表的类别持续失败时；健康类别保留原连接。失败类别恢复后会发布变化的目录；目录变化或连接退休后，安装新的不可变配置与连接代数。已准入请求保留原 pin，绝不重发。未确认或失败的 discovery 以错误结束当前 turn，不会永久阻塞 Session；下一轮可以重新刷新。配置或调用结果未知时仍必须对账原操作。取消 turn 会立即停止等待预热或刷新，并阻止该次刷新继续发现或替换；已经派发的工作保留原恢复身份。首个 prompt 同样适用：取消或 deadline 会停止等待初始配置，并阻止后续 server 配置与 input 准入。派发前已取消的 intent 保持未发送；`dispatch_started` 持久提交后，即使取消与日志确认竞争，仍只发送一次原配置，取消仅停止等待。恢复查询原 operation/owner，不会重发。初始化、刷新或替换仍在提交或获取所有权时，detach 保持恢复阻塞，不能在进行中的获取完成前释放。显式替换与刷新竞争时，尚未完成的配置让刷新以普通 turn 错误结束；已经完成的替换优先于旧的 discovery 结果。公开目录仍是已提交快照，不是 Runtime 实时健康或可用性检查。

Harness 空闲重载后，先推进现有配置记录的持久修订，再为新 writer 签发 grant；目录和连接 pin 保持不变。Runtime grant gate 仍拒绝同一修订更换 owner。初始配置明确失败后，显式替换命令可安装允许的新定义，无需先让失败的初始定义恢复。未决配置以 HTTP 503 阻止该 server 的新修订，但仍允许重试原显式配置命令。后续未知查询不能覆写已经明确失败或取消的配置。Detach 会按原操作对账所有未决配置，包括被旧版本 writer 的新配置越过的历史记录；只有明确结算并完成 drain 后才释放所有权。

连接释放持久化为 `active → releasing → drained → released`。`releasing` 只表示释放意图；`drained` 表示已取得确定的释放回执，或证明该配置从未打开连接。Harness 必须提交所有排空回执，才请求 Broker 释放原 owner。重新加载时跳过已排空连接，只重试原 owner 的释放，包括 Broker 释放确认丢失的情况。关闭超时后，只要物理 transport 仍打开，结果就保持未知；之后确认物理关闭时，原释放回执转为已结算，使后续配置能够继续排空。未知调用仍保留其占用。历史日志中的 `releasing → released` 转移仍可读取。对于旧写者留下且剩余记录均处于 releasing 或 drained 的状态，只有 Broker 明确拒绝获取原 owner、表明其准入已经关闭时，才允许重试原 owner 释放；Broker 仍须证明物理排空。网络错误及其他拒绝不得触发此恢复路径。必须先部署能够识别 `drained` 的 store，再部署写入它的 Harness；无需 SQL 迁移。本修复不会强制恢复被旧写者提前封锁、且仍持有打开连接的 Runtime Session。

## 准入、凭据与清理

Runtime 只允许目标 workspace 已配置的定义，以及 Session 已安装的 server binding。配置凭据留在 Runtime。Stdio command、参数、环境键和值不能包含 NUL；无效定义在分配连接前拒绝。公开目录不包含连接配方、环境、headers、endpoint、进程标识、grant 或内部 binding ID。错误使用有界稳定代码，不回显可能带凭据的底层连接异常。Hosted 原始操作路由在提交操作之前，拒绝资源 URI、prompt 名称以及参数键和值中的非法 Unicode。Broker 也在序列化前拒绝非法 Unicode，防止转发时静默改写请求内容。超大 MCP control 在转发给 Runtime 前返回不可重试的 413。

每个 Runtime 实例最多允许 16 个连接和 32 个在途请求，包括仍活动且等待 drain 的旧连接。收到响应即释放该请求的并发名额，即使响应内容非法，仍保留原操作以观察后续有效响应。超时或发送结果不明但尚未收到响应的请求，在连接存活时继续占用名额。已关闭连接保留未知结果证据和释放 hold，但不占用活动请求配额；未决副作用仍阻止 drain 确认释放。替换不能临时超额。Hosted Session 创建只接受 1–16 个 server pin，超限配置在创建 Session 前拒绝。旧版本已保存且最多含 32 个 pin 的 Session 保留原定义，仍可加载并 detach 以清理资源。替换先打开新连接，再退役旧连接。旧连接 drain 失败时保留该连接及其配额 hold，不销毁健康的新连接。只有三个指定的 MCP 列表变更通知能够使目录失效。正好有 16 个活动连接时没有替换余量：目录变更或显式替换持续返回配额错误，直到 detach/load 关闭旧连接并重新获取。需要实时目录刷新的部署必须留出一个空位（没有其他旧连接等待 drain 时，最多固定 15 个 server）。已有连接仍可能耗尽 Runtime 容量；prompt 准入、配置替换或原始操作初始化期间的配额失败返回 HTTP 409 和 `managed_mcp_connection_quota`，不会准入模型 turn。prompt 已准入后才发现的配额失败仍以 turn 错误报告。release 前封闭新准入；活动操作保留原 transport 直到结算。SDK 协议错误会退役连接，但不会判定活动请求丢失；物理关闭仍把未决请求转为结果未知。空闲退休连接立即关闭；繁忙退休连接仅在原请求结算后关闭。Streamable HTTP DELETE 采用一秒上限的尽力清理；release 表示全部请求结算后本地 transport 已关闭，不保证远端 server Session 被删除。本地关闭有时间上限，不能确认 drain 时不能 ACK release。Runtime/Session release 等待这些 hold。释放查询结果未知时，close 只可使用原 owner 与连接 pin 重发相同的幂等 release；调用与配置恢复仍不重发未知副作用。Broker 接管释放失败时，只移除本次插入的上下文，使后续恢复可以查询持久 binding，仍要求先证明旧 writer 已停止。未进入派发的配置可用 `not_started_proven` 取消；close 随后完成并释放原 Broker 所有权，包括此前因 Workspace busy 留下的未完成 acquire，期间不配置 MCP，也不重试 acquire。Broker 先将原 Runtime Session 持久置为 `RELEASING`，封闭后续 claim；确认它没有持有存储租约后即可释放，无需联系从未安装的 worker。仍持有租约时必须先完成物理停用，其他 Session 的租约不受影响。状态查询和取消在原始操作派发期间及 close 失败后仍可使用。两者彼此互斥，并与 close 互斥；新准入持续受限，直到派发及恢复请求均完成。

## 文件与接线点

- `packages/core/src/managed-runtime`：MCP 记录/协议、authority 接线及资源闭包。
- `packages/cli/src/serve`：MCP Runtime 服务/路由、worker 准入、Hosted 编排和模型目录。
- `packages/sdk-java/runtime-broker` 与 `managed-agent-server`：限定范围的转发、记录物化、目录契约和测试。
- `.qwen/e2e-tests/12827-h1.md`：基线、确定性协议测试和故障证据。

## 私有配置用法

在 Runtime 进程中将 `QWEN_MANAGED_MCP_CONFIG` 设为 manifest 的绝对路径。该文件由部署管理，绝不通过 Hosted API 传输。例如（digest 为部署 pin 示例）：

```json
{
  "version": 1,
  "servers": [
    {
      "tenantId": "tenant",
      "workspaceId": "workspace",
      "serverId": "demo",
      "serverRevision": 1,
      "definitionDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "transport": "stdio",
      "command": "node",
      "args": ["/opt/mcp/server.mjs"],
      "env": { "MCP_TOKEN": "deployment-secret" }
    }
  ]
}
```

`streamable-http` 或 `sse` 使用 `url` 和可选 `headers`，不能同时提供 `command`、`args`、`env`。定义在 Runtime 启动时装载；修改连接配方必须提供新的 `serverRevision` 和对应 digest。替换活动 binding 时应同时保留两个修订。可选 `timeoutMs` 为 1 至 600000 的整数，调用响应默认等待 600000 毫秒；连接和发现仍为 25 秒上限。Hosted 工具观察窗口为 630 秒，在临时 UNKNOWN 后继续查询原 execution；MCP 轮询通过 `GET /executions/:id?reconcile=true` 显式请求原 execution 对账，Java 仅持久接受明确的迟到 Runtime 结果。未显式请求对账的 v2 状态查询保持被动读取，v3 与通用 provider 引用保留自动对账。可选查询参数接受 `true` 或 `false`，不改变 execution 归属，也不允许派发。轮询复用已取得的 owner，状态查询失败时仅重建原 owner 路由。

创建或加载私有 Hosted Session 时，在原有 `managedSessionStore` 字段之外提供 `toolProfile: "hosted-workspace-mcp/1"` 和 `mcpServers: [{serverId, serverRevision, definitionDigest}]`。Session 保留初始准入 pin，后续替换单独提交。首个 prompt 或资源/提示操作会先初始化 binding，再受理工作。Hosted 请求沿用现有 Harness protocol/boot 与 client 身份 headers。

- `POST /session/:id/mcp/configurations`：`{operationId, expectedRevision, server: {serverId, serverRevision, definitionDigest}}`；UUID 标识一次不可变配置变更，`expectedRevision` 比较最近已受理的配置修订，包括失败的尝试。同一定义配合新的配置修订会通过新连接刷新发现。只能更新初始允许的 server ID。
- `POST /session/:id/mcp/operations`：`{operationId, serverId, request}`；request 为 `{kind: "resource_read", uri}` 或 `{kind: "prompt_get", name, arguments}`。只有内容相同才能复用原 UUID。
- `GET /session/:id/mcp/operations/:operationId` 与 `POST /session/:id/mcp/operations/:operationId/cancel` 查询原操作或请求取消。
- `GET /session/:id/mcp-catalog` 返回私有活动目录。经过认证的公开 `GET /v1/agents/sessions/{sessionId}/mcp-catalog` 读取已提交的展示信息和 schema；替换尚未完成或失败时，仍选择最近已发布的目录。已释放目录为 stale。该接口不配置或调用 MCP。

## 验证与验收

先用全局 CLI 尝试基线。局部验证使用确定性 MCP server 和假模型，证明模型确实看到并调用所选 MCP 能力。覆盖 stdio 和 HTTP，独立验证资源 blob 与完整提示消息。丢响应和重启场景保留请求次数与原 operation ID。

必要检查包括 Session/workspace 隔离、凭据隐藏、成功空目录与发现失败、在途调用期间替换、重复及冲突命令、取消后迟到成功、配额拒绝、丢 ACK 后查询原 owner、活动工作期间 release。按包运行定向测试、Java 契约测试、仓库 build/typecheck 与 bundle，再完整审查 diff 两轮。无法运行的门禁如实记录；目录展示或单元测试不足以证明生产迁移完成。

## 开放问题与限制

H1 明确保留每个 tenant/storage lease 同时仅一个 attached MCP owner 的限制。同一 Workspace 的其他 Session，以及共享该 storage 的其他 Workspace，即使在两次 turn 之间也不能执行；detach 后释放租约。stdio server 仍能访问 Workspace 时提前释放租约会允许并发写入；连接寿命与存储所有权解耦属于生产启用前的后续工作。

存在未决请求时物理连接丢失仍保持 recovery-blocked。取消 HTTP 响应丢失时按原 execution 身份重试；明确终态的 Runtime 丢失响应立即结束观察。其他连接丢失或 server 永不回复可能耗尽整个 630 秒 Hosted 观察窗口；更短的 Runtime 超时或取消不会缩短该窗口。模型请求前必须成功刷新所有固定 server，因此一个 server 不可用也会阻塞纯文本 turn 和健康 server 的调用，直到它恢复。工具在 630 秒 Hosted 观察窗口结束后才结算，或 Harness 在 turn 中途重启，仍需要本私有阶段尚未实现的 checkpoint 恢复。原始资源/提示操作可通过原 ID 的状态接口或 close 接受迟到结果。Runtime 回执历史及已关闭连接的 tombstone 仍保留至进程结束，随历史增长；基于持久 ACK 的回收，以及永久丢失请求的 release 等待者清理，留作后续工作。并发配额不代表历史内存有上限。

模型工具名有意包含目录和连接身份，防止旧广告调用静默使用新 binding；重新加载的历史可能保留旧名字。stdio HOME/USERPROFILE 为 Workspace；会写 HOME 缓存的 server 应通过部署定义显式设置独立 HOME。

Session 存储全局识别这两个记录 domain；实际执行仍由显式私有 profile 和限定范围的 Runtime 定义控制。共享 Broker acquire 有意对原 owner 幂等，并返回 workspace generation 与 Runtime binding/generation；普通文件/Shell prepare 保留实际 prompt 和 call 身份。

MCP migration 使用 V23，位于 #12894 已合入的 V20/V21/V22 publication migration 之后。部署应按递增顺序执行。如果 MCP V23 已先执行，后到达且尚未应用的 publication migration 必须重新编号到已部署版本之后，不能靠启用 out-of-order migration 绕过检查。#12868 的通用 control 与 MCP 撤权后的原 owner 恢复并存。正常 release 必须等待 provider 清理和 MCP hold 结束，再停用 Workspace 并释放存储租约；没有持有租约的 RELEASING Session 保留无需联系 worker 的清理路径。provider 不能接管已有 MCP 工具日志的 Session，MCP 工具派发在 context 查询后再次检查协议归属。

公开配置管理和生产 AgentBundle 能力发布另行部署。没有查询或幂等支持的远端系统不能自动恢复未知副作用。Runtime 的代内回执不能跨物理 Runtime 丢失持久保留；此时已提交的 Session intent 保持阻塞结果。配额按 Runtime 实例计算，不跨独立 Runtime 进程汇总。私有配置沿用现有 inline Session Store：每类发现列表限制为 16 KiB 和 64 页，保留部分条目时标记 partial，无法保留有效条目时标记 failed；原始操作响应限制为 60 KiB，超限以 output-limit 错误结算。本阶段不启用 SDK 反向客户端、生产 profile 公告、跨进程总预算或对象存储结果。
