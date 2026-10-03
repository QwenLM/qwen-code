# O4 工具输出保留：部署门禁与运维

[English](./managed-tool-output-retention-operations.md) · [生命周期设计](./managed-tool-output-retention.zh-CN.md)

## 部署决策

物理回收保持关闭。O2/O3、O4-1 与恢复后的 O4-2 均已合入 main。retention 使用 V30，依次为 recovery V31、close V32、AgentDefinition V33、collection V34；落地前联合 SQL、Java 两个迁移目录再次核对 main 最新编号。临时 close 或 collection 数据库历史需要显式核对或重建，不自动执行 Flyway repair。启用清理前必须升级**全部 Java publication writer**：旧实例可以绕过 attempt 台账执行 PUT，破坏写入闭合证据。

默认 `QWEN_MANAGED_AGENT_TOOL_PUBLICATION_GC_ENABLED=false`，删除宽限期为 `QWEN_MANAGED_AGENT_TOOL_PUBLICATION_DELETION_GRACE=24h`。物理回收关闭时仍执行观察。close、archive、ACK、事件过期及 Runtime 回收不会退役 Session 保留根。Session 成功删除建立不可逆的退役时间；修改宽限期不会重置时间。部署保持 24 小时策略，零宽限期仅用于全新隔离测试。

当前基线绑定 Workspace 的 Session DELETE 仍返回 `workspace_unavailable`；已合入的 close/drain 路径不会退役输出。因此，公开删除原子性测试使用关联私有输出 owner 的 legacy 公开 Session fixture。O4 提供受保护的完成屏障，不启用尚未完成的 Workspace 删除路径。完整 Hosted 门禁首先必须确认实际删除路径进入同一完成屏障。

只有下面的真实数据库、真实 OSS 及完整 Hosted 前台 Shell 门禁在目标部署 revision 上全部通过后，才能启用物理回收。不可用或跳过的门禁不算通过。本文不授权开启生产 GC。

## 可复现门禁入口

SDK Java workflow 对以 main 为目标的 PR 执行，并提供按分支手动触发入口。Linux MySQL 8.4 job 先保留完整 Hosted 报告，再单独运行 clean O4 文件系统 profile 与源码导出的完整性检查。O4 fixture 不能替代失败或跳过的 Hosted 家族、真实 OSS 或下面的完整前台 Shell 验收。测试 workflow 不开启部署 GC。

使用 Java 21，先按 Java SDK 和 Runtime Broker 的 README 构建并安装本 checkout 的依赖。O4 profile 要求启用 `performance_schema` 的真实 MySQL 8.4，不会静默替换为 H2。提供已有专用数据库 URL，库名以 `qwen_o4_` 开头，例如 `jdbc:mysql://127.0.0.1:3306/qwen_o4_gate`。测试身份需要隔离测试服务器上的 CREATE/DROP DATABASE 权限，以及对 `performance_schema.data_lock_waits`、`performance_schema.data_locks`、`performance_schema.threads` 的 SELECT 权限。这些元数据仅用于按 writer 连接 ID、随机库名和 tenant 表观察真实 InnoDB 锁等待。每个用例创建全新随机 `qwen_o4_` 数据库、迁移并只删除该生成库；不会清理传入的数据库。主测试数据源使用最多四个连接的池，删库前先关闭池。runner 中断后，清理前核对生成库名、用例目录及自己创建的子进程 PID；不得删除传入库。

通过测试环境设置 `QWEN_O4_MYSQL_PASSWORD`，不要放入命令参数。JDBC URL 和日志中不得包含凭据。支持 IPv6 literal host，以及 allowPublicKeyRetrieval、useSSL、sslMode、characterEncoding、connectTimeout、socketTimeout 这些非敏感选项，原样保留到生成库和子进程。拒绝 user/password、插件、userinfo 及其他选项。从干净报告目录运行完整 profile，不使用集成测试选择器；显式 Gate 类不属于普通 CI 的 IT 家族。仅 Maven 成功不足以作为证据，下面的源码导出报告检查也必须通过，且不得有跳过/失败用例或选择器属性。插件的 failIfNoSpecifiedTests 不能覆盖所有方法选择器的零测试情况，因此必须保留以 && 连接的两阶段入口，任一失败都不算门禁通过：

```sh
mvn -f packages/sdk-java/managed-agent-server/pom.xml \
  -P o4-mysql-gates \
  -Dqwen.o4.mysql.url=jdbc:mysql://127.0.0.1:3306/qwen_o4_gate \
  -Dqwen.o4.mysql.user=o4_test clean verify checkstyle:check && \
  node scripts/check-failsafe-reports.js o4-mysql packages/sdk-java/managed-agent-server
```

MySQL 门禁在真实 SQL 上执行保留与回收回归，证明 writer 等待退役锁，在物理 PUT/DELETE 完成而 SQL 确认之前杀死子 JVM，以 SIGSTOP 将读取暂停至真实两分钟租约过期，并在重试成功后释放延迟的未知 PUT。进程故障使用受控文件系统适配器。SIGSTOP/SIGCONT 需要 macOS 或 Linux；Windows 不能建立这项证据。子进程只写就绪/结果标记，不写原始输出或凭据。正常返回的 runner 在删库前杀死自己创建的子进程。活跃子进程暂停至多五分钟，或父进程退出时结束；必跑回归证明没有 resume 的子进程会退出。SIGSTOP 会阻止此 watchdog 执行：取消后先用确切子进程命令及用例目录核对 child.pid，再只终止自己创建的进程（包括 stopped 子进程），最后删除生成库。失败用例保留临时目录，断言输出 child.log。记录测试 revision、新鲜用例总数及保留的失败路径。

100 MiB 和 1 GiB 用例使用已接纳的 catalog fixture，包含 1 MiB 对象和 inline 元数据，测试 JVM 堆上限为 256 MiB。文件系统门禁还要求 fork 的 java.io.tmpdir 所在文件系统至少有 1.1 GiB 可用空间，小 tmpfs 不足；必要时换到更大文件系统。逐个读回全部已存分段，再验证 100 key 分页、精确字节账、最终 inline 清理、目录外对象保留及一次性配额回收。它们证明 collector 容量，不代表完整 O2 Shell 执行或生产 RSS 上限。受控 claim 过期及 SQL 异常验证恢复，不宣称真实数据库网络分区证据。

OSS profile 重跑数据库/进程用例，将容量用例替换为真实 OSS，并检查实际删除、不存在对象成功、丢弃删除应答及 DeleteObject 被拒绝的身份。必须使用从未启用版本控制的**专用私有桶**，桶名含 `o4-test`；每个存储用例创建全新 `o4-tests/<UUID>/` 前缀。清理只删除该用例拥有的确定 key，不修改桶 IAM，也不扫描前缀。

```sh
mvn -f packages/sdk-java/managed-agent-server/pom.xml \
  -P o4-oss-gates \
  -Dqwen.o4.mysql.url=jdbc:mysql://127.0.0.1:3306/qwen_o4_gate \
  -Dqwen.o4.mysql.user=o4_test \
  -Dqwen.o4.oss.region=cn-hangzhou \
  -Dqwen.o4.oss.test-bucket=my-o4-test-bucket clean verify checkstyle:check && \
  node scripts/check-failsafe-reports.js o4-oss packages/sdk-java/managed-agent-server
```

通过 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 及可选 `OSS_SESSION_TOKEN` 提供正常测试身份。通过 `OSS_DELETE_DENIED_ACCESS_KEY_ID`、`OSS_DELETE_DENIED_ACCESS_KEY_SECRET` 及可选 `OSS_DELETE_DENIED_SESSION_TOKEN` 提供负面测试身份。负面身份必须允许 GetBucketVersioning 和 GetBucketAcl，但拒绝新测试前缀的 DeleteObject；缺少身份会使门禁失败。两个身份均经同一个生产工厂执行固定地域 HTTPS endpoint 校验、V4 签名和零隐式重试。非零 SDK 上限仅将失败 GET 状态交给始终拒绝原生重放的策略，有界显式 GET 重试在每次请求前检查原守卫；PUT 和 DELETE 仍各只有一次 SDK 尝试。teardown 只重试尚未确认删除的 key，失败 PUT 的 key 仍被跟踪。OSS fork 总预算为 5400 秒，与每个容量方法的 1800 秒超时分开，为两个容量及继承的进程/数据库用例留出时间。保留完整分段读回证据；这些预算不保证慢速或限流链路能通过。fork 被杀后不能假定 cleanup 已执行：核对生成库、子进程 PID 及记录的全新 o4-tests/<UUID>/ 前缀，只删除本用例拥有的精确 key。应答丢失 fixture 在真实 OSS 删除成功后抛异常，不宣称网络自身丢掉了应答。

## 完整 Hosted 部署验收

使用独立测试 tenant、workspace、Session、隔离桶及唯一对象 key。记录 server、Harness、Broker revision，数据库引擎/隔离级别、OSS region、负载大小及每项测量来源。实际执行前台 Shell 命令，分别在 stdout/stderr 产生合计 100 MiB 和 1 GiB。删除 Session 前检查 catalog 长度/digest、manifest/pages、原始 outcome 及其 SQL/存储副本、恢复及公开 range 下载。

close/archive、ACK、事件过期及 Runtime 回收后，证明恢复仍读取相同输出，工具副作用标记保持一次。使 Session 删除与 writer acquisition、receipt commit、projection/backfill 及限速下载竞争。每次竞争必须保留有效引用或拒绝/等待，删除后不得重建 Artifact，并保持公开 404。验证过期下载进程恢复后不再返回字节，即使另一个请求已经取得新租约。

在每个 PUT 边界使用受控传输/进程故障。丢弃应答，让重试返回后再释放原延迟请求；原 UNKNOWN/IN_FLIGHT attempt 必须继续阻塞并占额。不能通过等待时间或成功 HEAD/GET 推断写入闭合。删除侧丢弃应答、在分页间杀 worker、断开确认 SQL，并让两个 server 实例竞争。验证重复精确 key、持久游标/generation、副作用次数不变，以及全部对象确认后只释放一次配额。partial、blocked、quarantined、恢复保护及历史证据缺失的 publication 必须保持保留。部署启用除了自动 catalog fixture，还需要这些实际 Hosted/OSS 观察证据。

## 观察与故障处理

observer 每分钟记录最多 100 条 RETIRING publication 的有界样本。候选数量、阻塞原因分布及 eligible 逻辑 used 字节均是**样本值**，不是总积压或桶物理容量。总阶段数量应另行查询：

```sql
SELECT retention_state, COUNT(*) AS publications,
       SUM(capture_used_bytes + producer_used_bytes + admission_used_bytes) AS logical_used_bytes,
       SUM(capture_held_bytes + producer_held_bytes + admission_held_bytes) AS held_bytes
FROM qwen_tool_publication GROUP BY retention_state;

SELECT state, COUNT(*) AS attempts
FROM qwen_output_put_attempt GROUP BY state;

SELECT gc_blocker, COUNT(*) AS publications
FROM qwen_tool_publication
WHERE retention_state IN ('RETIRING', 'DELETING') GROUP BY gc_blocker;
```

`gc_blocker` 由启用后的清理尝试填写；观察期间 NULL 不代表符合条件。逻辑 used 字节不包含 inline/OSS 副本的存储放大。应按 catalog 精确 key 及对应 inline 列核对物理容量，不能从配额推算或扫描桶前缀。

预期阻塞包括宽限期、活跃 reader、未解决 PUT、operation/object 证据未完成、历史写入证据缺失、隔离、接纳未完成及恢复保护。未解决写入和持续 `collection_retry` 应与正常宽限等待分别处理。每个 tick 最多检查 32 个到期候选并最多回收一页。宽限期等待将下次尝试设为原始退役时间加配置宽限期，避免在 24 小时窗口内每分钟轮询。其他阻塞、删除或 SQL 确认失败保持配额，一分钟后重试，允许健康 publication 继续推进。每页最多 100 key，对象间续租 claim，旧 generation 不可确认。多实例恢复在 claim 过期后重复幂等删除。

不能通过清除 UNKNOWN/IN_FLIGHT attempt、给历史行填 `write_evidence`/`accepted_complete`、释放配额、清除恢复保护、修改退役 generation 或删除墓碑来消除积压。旧证据继续受到保护；过期 publication 恢复属于 #13019。拥有对象存储权限的管理员若绕过 managed writer 路径重建 key，会破坏保证；这类写入不在回收契约内。

停止后续页面时，在全部 server 实例关闭 GC。正在执行的页面仍可完成 SQL 确认；关闭配置不能恢复已删除字节。保留墓碑和归零配额，修复故障后继续同一套 generation/游标协议。回收删除原始输出 payload，不擦除全部历史模型消息或公开预览。

## 证据记录

修复后的栈在 macOS 26.6.2 arm64、Java 21.0.12.1、Maven 3.9.16 和 MySQL 8.4.11 上验证。准确门禁总数与测试 revision 记录在 PR 独立报告中；继承用例数量随栈变化，旧数量不能建立完整性证据。普通 CI 仍是独立必跑测试家族。文件系统进程及 catalog 容量门禁与真实 OSS、完整 Hosted 验收分别记录。本机未配置真实 OSS 环境；真实 OSS 及完整 Hosted 前台 Shell 门禁仍必须通过，生产 GC 继续关闭。Windows、Linux、MariaDB 和实际 SQL 网络分区需要各自部署证据。
