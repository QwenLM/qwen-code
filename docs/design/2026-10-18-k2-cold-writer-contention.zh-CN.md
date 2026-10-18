# MySQL 上的 K2 冷 writer 争用

[English](2026-10-18-k2-cold-writer-contention.md) | [简体中文](2026-10-18-k2-cold-writer-contention.zh-CN.md)

状态：在已发布主干 V10/私有 V11 兼容合并后，基于 `a682de0e996a2b6bc0482e20bd89c55106646a14` 完成实现。MySQL 8.4 focused 运行中，普通、退役、READ COMMITTED 和预热 REPEATABLE READ 四项全部通过，包括 generation 2 claim 与 epoch 2 安装。完整模块检查及独立证据审查是单独的验证步骤。本项处理[冷恢复验收边界](2026-10-09-k2-native-history-integration.zh-CN.md#683-冷恢复验收与实现边界)要求的软件验证缺口，不实现物理释放，也不资格化 native 安装。

## 问题

原有两项 SQL worker 验收会生成真实 boot/6、attested handle/4、加密 binding、native journal、已授权文件效果及保留结果。两个场景均以 writer generation 1 结束。其他 READ COMMITTED 和 REPEATABLE READ 测试覆盖普通变更或 legacy 回调，未执行两个合格原 CSI 冷 acquire 的争用及胜者真实 activation 安装。

生产 acquire 在改变 writer ownership 前验证原 runtime 和完整 native tail；安装会再次验证该 tail。仅测试 phase 标记、直接 SQL 更新、普通 writer 或手工资格结果都会绕开这些消费者。

## 测试组成

扩展已有 SQL worker 集成测试及其 Node producer，保留普通和应用退役场景。为 READ COMMITTED 和 REPEATABLE READ 分别增加全新 MySQL 场景；每项独立拥有数据库、worker、HTTP 端点、进程及文件。

复用已有 provisioner、加密 binding、生产 HTTP client、runtime service 和真实有限文件 worker。第一组完整 Read/Write batch 通过原 native preparation、grant、真实文件效果、SQL settlement 和 receipt 生成。在最后原 receipt 返回之后、其 tool message 或 resolve 之前截取窗口。让未完成的 producer task 停在该边界；不能展开 Hook/Harness scope，使其在 cut 后追加成功或失败。

争用场景采用私有 Hosted owner 已使用的生产 authority-open、activation-install 和 record-sink 组成。fixture 显式持有 activation 续租 timer 及进行中的 renewal。先停止并等待该续租，再停止并等待 HTTP writer 续租。不能通过 retirement、activation release 或 writer seal 模拟旧 owner 消失。worker、原 runtime 及真实工作/备份文件实例保持存活，不能遗留现有 assembly helper 的独立 timer。

读取真实数据库时钟和两项持久 lease 到期值，等待自然过期。选择有效且有限的测试 lease，并通过正常生产有效期保持无关 runtime lease 有效。不得更新 expiry 列、替换数据库时钟，或插入正向 native/grant/result 行。

## 独立 acquire 与安装

创建两个独立 HTTP store client，writer ID 不同，持有同一原保留凭据。每个 client 的 journal open 必须实际发出 acquire。测试 adapter 用指定 isolation 下两个独立 JDBC Connection 执行请求，不能返回伪造 grant 或复用 memoized open。
冷场景的其他 adapter 事务，包括胜者的 activation commit，也在事务绑定 Connection 上使用并断言该 JDBC isolation。Resource-read receipt 事务保留生产 reader 组成。

在有效 cut 上，两项事务先进行真实一致性读，再允许竞争 ownership 更新。记录实际 isolation、autocommit、connection ID 及读到的原 generation/revision，使 RR 快照先于胜者 head 变化；仅设置 isolation 常量不够。第三条自有 Connection 持有原 tenant 的 runtime-placement guard，经 barrier 放行两项竞争者，通过 MySQL lock-wait/Connection ID 观测两条实际生产 acquire 查询均直接被该 holder 阻塞，再在生产五秒 guard 预算内释放锁。MySQL 还可能报告两个竞争者之间的一条队列边；逐条验证真实 Connection ID 和查询，不能强求恰好两行。内部 CSI continuation helper 先锁 Session root，再锁租户 guard，但 acquire 入口在调用它之前已经取得 placement guard。应兼容生产有界争用拒绝，不能假设所有败者无限等待。

要求恰好一份 generation 2 grant。另一个原请求必须拒绝，胜者仍有效时的新 retry 也不能 acquire。胜者通过实际 HTTP acquire grant、restore head 及完整 transaction pages 打开生产 authority。HTTP handle 没有 `takeoverCommitProof`；像 Hosted owner 一样依赖生产 transaction metadata、digest 及 scan/head sequence/epoch 校验，不从独立的本地 sealed-journal 合同拼造 expected proof。随后调用真实 TypeScript activation installer。要求 epoch 2、一次高层安装且仅有其声明的生产 phase 转换。安装前重放原先成功的 `executions:prepare` 请求，要求实际 installed-native-head guard 拒绝且 SQL/文件无变化。不能通过胜者 authority 发预期失败的 append，因为它会永久记录 write failure。测试不能提供安装回执。

同时在这两个 cold 原件上执行既有独立 content publication 入口：在原 writer/activation 有效时，用生产 HTTP tool-result store 发布首个真实 SETTLED 结果的实际字节。捕获真实 200 的原 wire 请求及 ref；相同请求重试必须为 200，且完整 SQL/文件像不变。读取 SQL 中原 `result_json` 的 UTF-8 字节，不能把重新序列化称为原字节相同。该 PUBLISHED resource 完整原行必须在 claim、restore、install 中保持。不能把它加入原退役正向场景：后者要求已引用的原生资源，本测试不建立该闭包。不修改生产权限或资源成员规则。

另捕获真实返回 200 的原 transaction 及 writer renewal。接管后以原凭据逐一重放全部三条原 wire 请求，每项均须拒绝且完整 SQL/文件像不变。本项仅资格化独立 content writer 谓词，不资格化 page/manifest 闭包、消费或退役。

## 保持不变量与失败证据

分窗口比较完整 typed table image。claim 只允许改变原 head 的 writer identity、generation、lease 及修改时间字段；使用同一保留凭据，token hash 必须准确不变。原 journal 字节、resource/reference、execution、grant、result 及 runtime ownership 保持不变。对当前 inline prefix，生产 authority 恢复只读取 head 和完整 transaction pages，不请求 resource。要求这些实际 GET 成功且完整 SQL/文件像，包括既有 resource 和 read receipt，保持准确不变；不能仅为满足观察器假设而增加 resource read。后续 Hosted receipt 修复和 resource hydration 属于其他验收 cut。安装只允许增加其真实 activation journal transaction、resource、JOURNAL ref 及对应 head 变化，并按实际 commit 请求核对。activation-only transaction 不新增 Session record。原行和原 prefix 保持准确，不能从比较中排除整张表。

记录前后 worker 身份、工作及备份文件字节、device/inode 和 request/effect counter。claim/install 不得产生新 bind、prepare、execute、文件效果、模型请求、结果消费或物理操作。败者及旧代请求和成功 claim/install 分别记录。失败尝试及观察器修正保留为独立证据。

## 范围与验收

两个 isolation 场景都必须在一次性 MySQL 8.4、当前已构建 Core/CLI 及 Java 源码上通过。回归未改的普通/退役场景，执行受影响 Java 检查、要求的完整模块检查及 root build/typecheck/bundle。独立验证须检查原始 SQL/native image、真实请求/回复、源码/产物摘要及自有资源清理。

这是组件级 claim/install 争用验收，不重跑历史 Main/Hosted SIGKILL C1 进程 cut，也不资格化 model2 continuation、全部其他冷 cut、page/manifest 闭包、生产 Linux CSI、原生隔离、物理 RELEASED、后续周期复用或公共选择。[物理完成要求](2026-10-11-k2-physical-completion.zh-CN.md)保持不变。本次工作不含云变更或特权安装。
