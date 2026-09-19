# Managed Agent 完整 LspApplication 本地生产级证明

状态：本地门禁通过

日期：2026-09-19

关联方案：[Managed Agent 公共 Agent API 适配层执行方案](./2026-09-18-managed-agent-public-api-adapter.md)

前置证据：[E1 契约冻结](./2026-09-19-managed-agent-e1-contract-evidence.md)、[E2 MySQL/Command Slice](./2026-09-19-managed-agent-e2-mysql-evidence.md)、[Harness/Broker/Runtime 完整进程 E2E](./2026-09-19-managed-agent-local-process-evidence.md)

## 1. 结论

当前代码已通过一轮不使用 mock Java Controller、mock Harness 或内存数据库的本地完整应用验收：两个真实 `LspApplication` JVM 共享真实 MySQL，经公开 `/v1/agents/**` API 调用真实 `qwen serve --profile hosted-harness`、Java Runtime Broker、独立 Managed Runtime Worker 和 ACP 工具进程。仅模型供应商由确定性本地 OpenAI-compatible server 代替，以冻结模型输出并制造 3 秒 Runtime 冷启动窗口。

本轮证明了以下关键性质：

- 首个模型 delta 不等待 Runtime ready，同一 Turn 在 Runtime ready 后继续执行真实工具；
- Session 由节点一创建后，可由节点二读取、重放 SSE、读取 Item 并执行同幂等键重放；
- 同一创建请求的幂等重放不增加物理 acquire 或 execute；
- 公开事件序列严格递增，MySQL durable 序列无重复且只有一个 terminal；
- 跨租户猜测返回 404；公开 Session、Item、SSE 和 replay 响应未出现 Harness/Runtime endpoint、token、lease 或本地工作区绝对路径；
- Harness 代际变化会 fail closed 为 `managed_generation_mismatch`，不会回退或接管旧代 Session；
- 默认审批模式仍为 `DEFAULT`；本地无人工验收显式使用部署参数 `approval-mode=yolo`。

这不是生产开放结论。真实 ACS/DataAgent Runtime、签名 BFF/反向代理、真实模型、负载均衡和灰度流量仍是外部门禁。

## 2. 验收拓扑

```text
公开 Agent API client
  -> LspApplication :18081（创建）
  -> LspApplication :18082（查询、SSE、幂等重放）
       -> shared MySQL
       -> qwen serve --profile hosted-harness
            -> deterministic local model server
            -> Java Runtime Broker
                 -> Managed Runtime Worker
                      -> qwen ACP tool process
                           -> foreground run_shell_command side effect
```

两个产品 JVM 使用同一份构建产物和同一 MySQL schema；客户端显式切换节点模拟负载均衡后的跨节点请求。Hosted Harness 和 Runtime 使用真实独立进程，Runtime Worker 启动前人为延迟 3000 ms。

## 3. 完整启动暴露并修复的问题

| 问题                                                                  | 真实表现                                                        | 修复与回归                                                                                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ACP `ContentBlock.type` 持久化往返丢失                                | 重建 admission digest 时得到 `managed_admission_rebuild_failed` | `AcpSchema.ContentBlock` 的 `EXISTING_PROPERTY` 增加 `visible = true`；新增持久化 JSON 往返测试                                            |
| 公共 API 没有 permission response 路由，而 Harness 默认要求写工具审批 | 模型 delta 已返回，但 Turn 停在 `permission_request`            | Hosted Harness 增加部署级 `approval-mode`，默认 `DEFAULT`；仅无人值守环境显式选择 `YOLO`，create 与 outcome-unknown 同 ID 重试使用同一配置 |
| `/v1/agents/**` 未进入 BFF 上下文过滤链                               | 公开请求无法获得统一 tenant/operator context                    | `ApiAuthFilter` 纳入 `/v1/agents/`，同时从旧 SSO 链排除；增加三条过滤范围测试                                                              |
| 本地 H2 初始化表缺少已有 Session 字段                                 | 完整 `LspApplication` 启动时 schema 与 Mapper 不一致            | `chat_session.sql` 补齐 `session_status`、`agent_name`                                                                                     |

验收期间还验证了两类正确拒绝：Harness 重启但 Java 未重启时由 boot fencing 返回 `managed_generation_mismatch`；向 `write_file` 传相对路径时 Tool Runtime 按工具合同拒绝。最终副作用场景改用前台 `run_shell_command`，避免把工作区绝对路径放入公开 Tool 参数。

## 4. 构建与定向测试

| 门禁                                                                          | 结果                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| Hosted Harness property、admission JSON 往返、Session command、Turn reconcile | 17 tests，0 failures，0 errors，0 skipped             |
| `/v1/agents/**` BFF filter 范围                                               | 3 tests 通过                                          |
| 产品完整构建                                                                  | 21 个 Maven reactor 模块 `clean package` 全部 SUCCESS |
| 最终 fat JAR                                                                  | `lsp-server-outside.jar`，631675305 bytes             |
| Qwen Hosted Harness/Broker/Runtime 基线                                       | 延续本地四场景完整进程门禁，详见前置证据              |

完整产品构建使用 JDK 21，跳过测试后重新清理并打包；定向测试在打包前独立执行。两个 JVM 均从这份最终 JAR 启动。

## 5. 冷 Runtime 快路径

冷启动 Session：`ece18bfe-ecf0-4963-b90f-bc32263be365`

Turn：`0176b706-3655-4e14-b24c-c8d59be8bf42`

| 时间点                                             |      epoch ms |
| -------------------------------------------------- | ------------: |
| 首个公开模型 delta 对应的 Harness server timestamp | 1789761716808 |
| Broker provision started                           | 1789761716829 |
| Runtime ready                                      | 1789761720351 |
| Turn completed                                     | 1789761721343 |

首模型 delta 比 provision started 早 21 ms，比 Runtime ready 早 3543 ms。Runtime ready 后工具继续完成，Broker 记录一次 physical start、一次 acquire、一次 execute；副作用文件内容为 `full product tool execution completed`。

该时间只证明本地架构上的先后关系，不代表真实外部模型 TTFT；真实模型和 ACS 的 P50/P95/P99 仍需在试点环境采集。

## 6. 双 JVM、幂等、事件和隔离

最终审计 Session：`36f1d3ee-ee7d-45ea-8747-4d8d20d88146`

Turn：`8ec5d0fe-f2c5-4b8d-9fa8-c1f1fc758c71`

- 节点一创建耗时 65 ms；节点二观察到 terminal 的端到端时间为 780 ms；
- 节点二读取 Session 状态为 `idle`，读取到 5 个 Item；
- 公开 SSE 序列为 `1,2,4,5,6,7,8,10,11,12`，严格递增；缺口是被公共 Adapter 有意过滤的内部 diagnostic；
- 公开事件包含模型 delta、`run_shell_command` function call added/done 和 turn completed；
- MySQL 中对应 durable 事件为 12 条，`COUNT(DISTINCT public_sequence)=12`，terminal 数量为 1；
- Command Ledger 只有一个 `CREATE_SESSION / DISPATCHED` 记录，Session 表只有一行、current binding 只有一行；
- 相同 tenant/operator、相同 `Idempotency-Key` 在节点二重放，返回原 Session ID；Broker physical acquire/execute 在首次请求各增加 1，重放后均不再增加；
- 改用另一 tenant 读取同一 Session 返回 404；
- 对 create、Session、Item、SSE 和 replay 全部公开 payload 扫描内部 endpoint、Harness/Broker/control token、lease 字段和宿主机临时目录，命中数为 0。

公开 SSE 的序列缺口不改变 durable public sequence：服务端只隐藏事件内容，不重编号。本轮验证了从头 replay 的有序性；携带 `Last-Event-ID` 的代理断流重连仍属于 E3 真实 BFF 门禁。

## 7. 当前剩余生产门禁

1. 在真实 DataAgent/ACS Runtime 上重复冷启动、execute response lost、cancel、Runtime/Harness crash 和三个 provision crash window；
2. 通过真实签名 BFF/反向代理验证鉴权、POST SSE、`Last-Event-ID`、heartbeat、代理 idle timeout、慢消费者和客户端 abort；
3. 把两 JVM 放到真实负载均衡后，补 Turn/Item/Artifact/cursor 全资源跨租户矩阵和 owner crash；
4. 用真实模型采集 create latency、TTFT、Runtime ready、首 Tool wait、Turn terminal 的 P50/P95/P99；
5. 开启只读 shadow，达到约定观察窗口内零未解释 mismatch 后，才按单用户、1%、10% 打开写流量；
6. 在上述门禁完成前保持 `copilot.agent.agent-api.openai.enabled=false` 和 `write-enabled=false`。

本地最小 MySQL schema 没有承载与 Managed Agent 无关的全部定时任务表，因此启动日志中存在无关 scheduler 查询失败；它不影响本轮 Managed 链路，但正式环境验收必须使用完整产品 schema 并要求应用健康检查为 UP。
