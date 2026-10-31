# hosted gate driver 与 probe 的共享 helper(#14147)

[English](2026-10-17-hosted-gate-shared-helpers.md) | [简体中文](2026-10-17-hosted-gate-shared-helpers.zh-CN.md)

## 问题陈述

各 hosted 故障门禁 lane(FG6e、FG7、FG8、FG9、FG10a)各自携带了自己的 driver(`integration-tests/helpers/hosted-*-driver.ts`)、probe(`Hosted*Probe.java`)与 IT 类。FG8 PR(#14120)的第 1 轮评审标记了五处「新门禁类把既有机制拷贝到第 N 份私有副本」的位置;当时每类各持私有副本是该 lane 的刻意约定,所以为保住 FG8 PR 的 diff 范围,抽取被延后,#14147 跟踪这次清扫。此后 FG10a 又落地了一组 driver/probe/IT,给同一批模式添了新拷贝——其中一份还以要紧的方式偏离了原件(见第 6 项)。

私有拷贝会漂移。目前已见的具体代价:FG10a 的 probe 重新实现 extension-record 读取时,丢掉了 `session_scope_key` 索引前缀谓词——FG8 probe 的注释明确记载该谓词是承重墙(不带索引前缀、只按 tenant+session 的查询形态会扫描该 lane 迄今写入的全部字节)。每多写一个 letter,下一次抽取就更贵一分。

## 现状(实测)

完整的重复面测绘,核实于 `main` = `e847c14496`:

| #   | 机制                                                                     | 拷贝位置                                                                                                                                                                                                           | 分叉点                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SSE `Observer` 类 + 事件投影(TS)                                         | `hosted-sse-gap-driver.ts`(FG6e:Observer 在 :81,内联投影映射在 :339)↔ `hosted-monitor-run-fault-driver.ts`(FG8:Observer 在 :44,`projection()` 在 :1002)                                                           | SSE 块解析循环与「行→事件」字段映射逐字节相同。FG8 的 Observer 经构造器接收 `(surface, sessionId)`、超时 300 s,并多出 `turnIdOf`(snake_case/camelCase 双面)与 `terminalOfOtherTurn()`;FG6e 的读模块级 config、超时 45 s、另有 `through()`。                                                                                                                                                               |
| 2   | `authentication(tenant)` servlet 过滤器(Java)                            | `HostedSseGapProbe` ↔ `HostedMonitorRunProbe`                                                                                                                                                                     | 逐字相同,仅 fixture 名(`fg6e-fixture` / `fg8-fixture`)。                                                                                                                                                                                                                                                                                                                                                  |
| 3   | probe 的 SSE relay 循环(Java)                                            | `HostedSseGapProbe.relay` ↔ `HostedMonitorRunProbe.relay`                                                                                                                                                         | 相同部分:client 构建参数(fixture token、capability digest)、boot-id 能力校验、`parseSession` 反射桥、`streamEvents(lastEventId, eventEpoch)`、投影后 `appendPublicEventIfAbsent`、源键 `bootId:epoch:eventId`。循环控制分叉:FG6e 钉住单个 `promptId`、把 terminal 事件在落库前用闩扣住、terminal 即跳出;FG8 每事件读 turn、从不主动跳出、靠 stop 闩加流关闭来停(吞掉关闭引发的 `IllegalStateException`)。 |
| 4   | 工具发布调优块 + OSS stub(Java)                                          | `HostedPublicWorkspaceIT.startSpring`(:1310–1325 + :1349–1381)↔ `HostedMonitorRunFaultGatesIT.runLetter`(:175–191 + :237–255)                                                                                     | 16 行属性逐字相同,仅 `oss-bucket` 与 `execution-bytes`(1 MiB 对 1 GiB)不同。OSS Mockito stub 支持的方法集不同:发布 IT 的 stub 服务 `putObject`/`getObject`(它真的走发布);FG8 的只服务 `getBucketVersioning`/`toString`,其余一律抛错。                                                                                                                                                                     |
| 5   | `quote()` POSIX 单引号转义(TS)                                           | `hosted-shell-output-driver.ts:284`、`hosted-provider-control-driver.ts:182`、`hosted-workspace-tool-turn-driver.ts:297`、`hosted-monitor-run-fault-driver.ts:325`                                                 | 三种排版变体,语义逐字节相同。                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | extension-record 的 JDBC 读取(Java)——**不在 issue 清单内,随 FG10a 落地** | `HostedMonitorRunProbe.extensionRecords`(:241)、`HostedWorkflowProbe.extensionRecords`(:83),以及单条变体 `HostedMonitorRunFaultGatesIT.extensionRecord`(:1531)、`HostedWorkflowFaultGatesIT.extensionRecord`(:351) | FG10a 的拷贝丢掉了 FG8 注释记载为性能关键的 `session_scope_key` 前缀谓词。                                                                                                                                                                                                                                                                                                                                |

## 目标

- 每个机制抽取到唯一的家;items 1–5 的全部携带者在同一个 PR 里一起搬(按 issue 的要求,半抽取不如不抽)。
- 第 6 项随行:它有四个携带者,其中两个就在本 PR 本来就要改的文件里,且这次抽取顺手修复 FG10a 丢掉的索引前缀。这是超出 issue 原列五项的唯一增补;其余观察到的重复(driver 的 `diagnose()`、store-proxy 样板)保持私有——两个携带者且有真实分叉,还没有挣到共享抽象。
- 零行为变化:每道门禁必须因与今天相同的理由而通过。本次清扫在构造上保持语义不变,完整 `hosted-harness-mysql` lane 的全绿就是证据。

## 非目标

- 不改任何生产代码。
- 不新增门禁、letter 或 case;不改任何断言。
- 不去重 driver 的故障注入臂、case 编排或每-letter 的夹具——那些是各 letter 自己的本体。
- FG10b/c/e/f 仍排在本重构之后(按 #14165)。

## 拟议改动

### TypeScript:两个新的单职责 helper 模块

沿用既有先例(`hosted-harness-process.ts`、`hosted-relay-headers.ts` 都是单职责共享模块):

- `integration-tests/helpers/hosted-sse-observer.ts` —— `Observer` 类(SSE fetch、块解析、`frames`、`through`、`terminalOfOtherTurn`、`turnIdOf`、`close`),`surface`、`sessionId`、`storeUrl`、`tenantId` 与超时全部经构造器注入;外加 `projectEvents(rows, surface)`,逐字承载 FG6e/FG8 的字段映射。FG6e 的 driver 不再为 observer 读模块级 config;两个 driver 都改为 import 该类。
- `integration-tests/helpers/hosted-shell-quote.ts` —— `quotePosix(value)`。四个调用点把本地 const 换成 import。

### Java:一个包级私有的测试支撑类

`com.alibaba.qwen.code.managedagent.HostedGateTestSupport`(final class、静态方法、test 作用域),加入既有测试支撑先例(`CoordinatorTestSupport`)之列:

- `authentication(String tenant, String fixtureName)` —— `FilterRegistrationBean` 工厂;两个 probe 都改为委托,fixture 名是唯一参数。
- relay 循环的共享机制:用钉死的 fixture token 与 capability digest 构建 client、boot-id 能力校验、`parseSession` 反射桥,以及「流 → 投影 → 落库」的行走,源键为 `bootId:epoch:eventId`。各 letter 的循环控制留在一个小策略缝后面,恰好三个钩子——事件属于哪个 turn(FG6e 的固定 `promptId` 对 FG8 的每事件 prompt id)、一个允许阻塞的落库前钩子(FG6e 的 terminal 闩)、以及 terminal 是否停下的决定(FG6e 遇 terminal 跳出;FG8 从不,靠流关闭停下)。FG8 关闭流引发的 `IllegalStateException` 吞留处理留在 FG8 的 probe 里。
- `toolPublicationArgs(int servicePort, String bucket, long executionBytes)` —— 那 16 行属性。
- `stubPublicationOss(context, fixtureName)` —— 两份 stub 方法集的并集(`getBucketVersioning`、带 FileAlreadyExists 语义的 `putObject`、带 NoSuchKey 的 `getObject`、`toString`),其余方法一律抛错并点名 fixture。FG8 的严格性保持不变:它从不调用 `putObject`/`getObject`,而其他方法仍触发 default-throw。
- `extensionRecords(jdbc, tenant, sessionId, domain)` / `extensionRecord(...)` —— record+resource 的 JDBC 读取,统一为 FG8 注释记载的 `session_scope_key` 前缀查询形态;FG10a 的 probe 与 IT 搬到其上,恢复索引前缀谓词。

## 受影响文件

- 新增:`integration-tests/helpers/hosted-sse-observer.ts`、`integration-tests/helpers/hosted-shell-quote.ts`、`packages/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedGateTestSupport.java`。
- 就地更新的 TS 携带者:`hosted-sse-gap-driver.ts`、`hosted-monitor-run-fault-driver.ts`、`hosted-shell-output-driver.ts`、`hosted-provider-control-driver.ts`、`hosted-workspace-tool-turn-driver.ts`。
- 就地更新的 Java 携带者:`HostedSseGapProbe.java`、`HostedMonitorRunProbe.java`、`HostedWorkflowProbe.java`、`HostedPublicWorkspaceIT.java`、`HostedMonitorRunFaultGatesIT.java`、`HostedWorkflowFaultGatesIT.java`、`HostedWorkspaceToolTurnIT.java`。

## 风险

- 本次清扫触及已定型的门禁文件,任何移植滑手都会把每条 hosted lane 染红。缓解就是 issue 自己的验收门槛:本地完整跑一遍 `hosted-harness-mysql` lane 作证,而不是按类抽查;外加 CI 元钉(`hosted-process-ci.test.js`、`hosted-relay-headers.test.ts`)、checkstyle 与 ESLint。
- FG6e relay 的 terminal 闩把事件扣在落库**之前**——这个次序正是该测试的本体,所以策略缝必须让落库前钩子保持可阻塞。

## 验证计划

1. 基线:`main` 在该 lane 上为绿(CI 的 Java workflow 会跑它);记录基线。
2. 改后证据:本地完整 `hosted-harness-mysql` lane(`mvn -Phosted-harness-mysql failsafe:integration-test failsafe:verify`,配一次性 MySQL),每个类全绿。
3. 静态钉:vitest 跑 `scripts/tests/hosted-process-ci.test.js` 与 `hosted-relay-headers.test.ts`,`checkstyle:check`,对改动的 TS 文件跑 ESLint,以及 TS 侧的 `npm run build`。

## 验收标准

- items 1–5 的每份拷贝只剩唯一的家;全部携带者在同一 diff 内搬迁;没有任何携带者保留私有变体。
- 第 6 项的读取在全部四个携带者里都走共享的、索引前缀的查询。
- 完整 hosted lane 不变地通过;CI 元钉、checkstyle、lint 保持全绿;零生产文件改动。

## 待定问题

目前无——第 6 项的纳入已在上面论证;若评审不同意,它可以独立撤出而不影响 items 1–5。
