# O4 工具输出保留：部署门禁与运维

[English](./managed-tool-output-retention-operations.md) · [生命周期设计](./managed-tool-output-retention.zh-CN.md)

## 部署决策

物理回收保持关闭。O4 实现叠加在尚未合并的 O2/O3 上，落地前必须对齐其最终接口及最新 main 的迁移编号。本分支迁移是前向增量，不能复用 main 上已经部署的版本。启用清理前必须升级**全部 Java publication writer**：旧实例可以绕过 attempt 台账执行 PUT，破坏写入闭合证据。

默认 `QWEN_MANAGED_AGENT_TOOL_PUBLICATION_GC_ENABLED=false`，删除宽限期为 `QWEN_MANAGED_AGENT_TOOL_PUBLICATION_DELETION_GRACE=24h`。物理回收关闭时仍执行观察。close、archive、ACK、事件过期及 Runtime 回收不会退役 Session 保留根。Session 成功删除建立不可逆的退役时间；修改宽限期不会重置时间。部署保持 24 小时策略，零宽限期仅用于全新隔离测试。

当前 O3 基线对绑定 Workspace 的 Session 生命周期 operation admission 返回 `workspace_unavailable`。因此，公开删除原子性测试使用关联私有输出 owner 的 legacy 公开 Session fixture。O4 提供受保护的完成屏障，不启用尚未完成的 Workspace 生命周期路径。完整 Hosted 门禁首先必须确认实际删除路径进入同一完成屏障。

只有下面的真实数据库、真实 OSS 及完整 Hosted 前台 Shell 门禁在目标部署 revision 上全部通过后，才能启用物理回收。不可用或跳过的门禁不算通过。本文不授权开启生产 GC。

## 可复现门禁入口

使用 Java 21，先按 Java SDK 和 Runtime Broker 的 README 构建并安装本 checkout 的依赖。O4 profile 要求真实 MySQL，不会静默替换为 H2。提供已有专用数据库 URL，库名以 `qwen_o4_` 开头，例如 `jdbc:mysql://127.0.0.1:3306/qwen_o4_gate`。测试身份需要 CREATE/DROP DATABASE 权限。每个用例创建全新随机 `qwen_o4_` 数据库、迁移并只删除该生成库；不会清理传入的数据库。runner 中断后，清理遗留测试库之前先核对生成库名。

通过测试环境设置 `QWEN_O4_MYSQL_PASSWORD`，不要放入命令参数。JDBC URL 和日志中不得包含凭据。以下命令在显式启用的集成阶段前只选择针对性单元测试：

```sh
mvn -f packages/sdk-java/managed-agent-server/pom.xml \
  -P o4-mysql-gates -Dtest=ToolPublicationCollectorTest \
  -Dqwen.o4.mysql.url=jdbc:mysql://127.0.0.1:3306/qwen_o4_gate \
  -Dqwen.o4.mysql.user=o4_test verify
```

MySQL 门禁在真实 SQL 上执行保留与回收回归，证明 writer 等待退役锁，在物理 PUT/DELETE 完成而 SQL 确认之前杀死子 JVM，以 SIGSTOP 将读取暂停至真实两分钟租约过期，并在重试成功后释放延迟的未知 PUT。进程故障使用受控文件系统适配器。SIGSTOP/SIGCONT 需要 macOS 或 Linux；Windows 不能建立这项证据。子进程只写就绪/结果标记，不写原始输出或凭据。runner 在删除数据库前杀死自己创建的子进程。

100 MiB 和 1 GiB 用例使用已接纳的 catalog fixture，包含 1 MiB 对象和 inline 元数据，测试 JVM 堆上限为 256 MiB。验证 100 key 分页、精确字节账、最终 inline 清理、目录外对象保留及一次性配额回收。它们证明 collector 容量，不代表完整 O2 Shell 执行或生产 RSS 上限。受控 claim 过期及 SQL 异常验证恢复，不宣称真实数据库网络分区证据。

OSS profile 重跑数据库/进程用例，将容量用例替换为真实 OSS，并检查实际删除、不存在对象成功、丢弃删除应答及 DeleteObject 被拒绝的身份。必须使用从未启用版本控制的**专用私有桶**，桶名含 `o4-test`；每个存储用例创建全新 `o4-tests/<UUID>/` 前缀。清理只删除该用例拥有的确定 key，不修改桶 IAM，也不扫描前缀。

```sh
mvn -f packages/sdk-java/managed-agent-server/pom.xml \
  -P o4-oss-gates -Dtest=ToolPublicationCollectorTest \
  -Dqwen.o4.mysql.url=jdbc:mysql://127.0.0.1:3306/qwen_o4_gate \
  -Dqwen.o4.mysql.user=o4_test \
  -Dqwen.o4.oss.region=cn-hangzhou \
  -Dqwen.o4.oss.test-bucket=my-o4-test-bucket verify
```

通过 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 及可选 `OSS_SESSION_TOKEN` 提供正常测试身份。通过 `OSS_DELETE_DENIED_ACCESS_KEY_ID`、`OSS_DELETE_DENIED_ACCESS_KEY_SECRET` 及可选 `OSS_DELETE_DENIED_SESSION_TOKEN` 提供负面测试身份。负面身份必须允许 GetBucketVersioning 和 GetBucketAcl，但拒绝新测试前缀的 DeleteObject；缺少身份会使门禁失败。两个客户端均使用固定地域 HTTPS、V4 签名及零隐式重试。应答丢失 fixture 在真实 OSS 删除成功后抛异常，不宣称网络自身丢掉了应答。

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

预期阻塞包括宽限期、活跃 reader、未解决 PUT、operation/object 证据未完成、历史写入证据缺失、隔离、接纳未完成及恢复保护。未解决写入和持续 `collection_retry` 应与正常宽限等待分别处理。删除或 SQL 确认失败保持配额，持久记录一分钟重试延迟并允许健康 publication 继续推进。每页最多 100 key，对象间续租 claim，旧 generation 不可确认。多实例恢复在 claim 过期后重复幂等删除。

不能通过清除 UNKNOWN/IN_FLIGHT attempt、给历史行填 `write_evidence`/`accepted_complete`、释放配额、清除恢复保护、修改退役 generation 或删除墓碑来消除积压。旧证据继续受到保护；过期 publication 恢复属于 #13019。拥有对象存储权限的管理员若绕过 managed writer 路径重建 key，会破坏保证；这类写入不在回收契约内。

停止后续页面时，在全部 server 实例关闭 GC。正在执行的页面仍可完成 SQL 确认；关闭配置不能恢复已删除字节。保留墓碑和归零配额，修复故障后继续同一套 generation/游标协议。回收删除原始输出 payload，不擦除全部历史模型消息或公开预览。

## 证据记录

首轮实现在 macOS、Java 21.0.8、Maven 3.9.14 和 Homebrew MySQL 26.7.0（InnoDB、REPEATABLE-READ）上验证。准确测试数量与 revision 记录在 PR 独立 E2E 报告中。文件系统进程及 catalog 容量门禁与真实 OSS、完整 Hosted 门禁分别记录。首轮没有可用真实 OSS 环境，生产 GC 继续关闭。Windows、Linux、MariaDB、实际 SQL 网络分区及完整 Hosted/OSS Shell 闭包仍未验证，直到补充各自证据。
