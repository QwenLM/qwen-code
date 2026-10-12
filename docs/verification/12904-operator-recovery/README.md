# Hosted Shell operator recovery acceptance

This acceptance for [#12904](https://github.com/QwenLM/qwen-code/issues/12904) exercises the recovery already shipped by [#12977](https://github.com/QwenLM/qwen-code/pull/12977). It does not add another recovery mechanism.

Run the packaged CLI, real worker, Runtime Broker, Spring store and maintenance command on Linux with Java 21, Node 22+, and an isolated MySQL or MariaDB database. Only the model endpoint is deterministic. Build the CLI and bundle first, then install the Java SDK and Broker artifacts as in the SDK Java workflow.

```sh
mvn --batch-mode --no-transfer-progress \
  -f packages/sdk-java/managed-agent-server/pom.xml \
  '-Dtest=HostedWorkspaceToolTurnIT#operatorRecoveryReleasesOnlyTheOriginalQuiescentShellOnMySql' \
  -Dnode.executable="$(command -v node)" \
  -Dqwen.cli.entry="$PWD/dist/cli.js" \
  -Dmysql.url='jdbc:mysql://127.0.0.1:23060/qwen_12904?allowPublicKeyRetrieval=true&useSSL=false' \
  -Dmysql.user=root -Dmysql.password=qwen-acceptance-only \
  test
```

The example credentials belong only to the disposable acceptance database. Repeat against MariaDB using its isolated port and schema. The test fails if Linux, SQL or the packaged bundle is unavailable.

The test observes three independent Workspaces:

- The original compound command retains its Workspace after a `partial` / `producer_lost` result. A second Session receives `workspace_busy`.
- A second compound command starts a real detached writer. After the original worker dies, the writer must still be alive and its file must keep growing while the exact Workspace holder remains fenced.
- An independent Workspace can still complete a file operation while the other two are blocked.

Recovery invokes the real maintenance entry point in separate JVMs: inspect the original binding and generation, prepare the exact held lease, stop the fixture's workers and potential writers, and submit a private quiescence statement. Completion is retried with the same evidence file. SQL must show the original lease removed and binding retired; a new Session must actually write a file in the recovered Workspace. The original marker must remain a single `x`, and recovery itself must not call the model again.

Success includes `HOSTED_OPERATOR_RECOVERY_OK` and identity-bearing `OPERATOR_RECOVERY` records. Retain the Surefire report and process output when a check fails. This does not certify arbitrary escaped processes, external restart sources, cross-host recovery, or completion of the original uncertain turn. The operator statement remains the trust boundary described in the [recovery procedure](../../../docs/users/hosted-workspace-recovery.md).

## Recorded acceptance — 2026-10-09

The production baseline was `669b2f0f91b0c787f7d8a26971c7c34210b935e1`. The unchanged packaged CLI had SHA256 `11db529ca76a62e3b19c95269da45583ffb6b820b5e9619ae38bb973661c5c2d`. Both runs used Ubuntu 24.04 arm64, Linux 6.8.0-146-generic, Java 21.0.12.1 and Node 22.23.3 in an isolated local VM.

| Database        | Tests / failures / errors / skipped | Test duration | Result                        |
| --------------- | ----------------------------------- | ------------- | ----------------------------- |
| MySQL 8.4.11    | 1 / 0 / 0 / 0                       | 21.17 s       | `HOSTED_OPERATOR_RECOVERY_OK` |
| MariaDB 11.4.13 | 1 / 0 / 0 / 0                       | 23.84 s       | `HOSTED_OPERATOR_RECOVERY_OK` |

In both runs, the detached case recorded `escapedWriterLive=true` after the original worker was killed; its holder stayed fenced. Both recoveries completed with replacement binding identities, and both replacement Sessions wrote `available` while the original marker remained `x`. The maintenance retry and no-replay assertions also passed. These runs selected the legacy saved-result Shell profile. `W1_PHYSICAL_GUARD=false`; they do not certify W1 mount/backup isolation or H3 background/Monitor publication, restart or drain behavior.

<details>
<summary>中文</summary>

本验收对应 [#12904](https://github.com/QwenLM/qwen-code/issues/12904)，测试 [#12977](https://github.com/QwenLM/qwen-code/pull/12977) 已交付的恢复机制，不新增另一套恢复逻辑。

使用 Linux、Java 21、Node 22+ 和独立 MySQL 或 MariaDB 数据库，运行打包后的 CLI、真实 worker、Runtime Broker、Spring 存储服务及运维命令。仅模型端点返回确定性响应。先构建 CLI 和 bundle，再按 SDK Java 工作流安装 Java SDK 和 Broker 构件。上方命令只运行新增的验收方法；示例凭据仅用于可丢弃的验收数据库。将端口和数据库名换成独立的 MariaDB 配置后再次运行。缺少 Linux、SQL 或打包产物时，测试会失败。

测试观察三个独立 Workspace：原始复合命令产生 `partial` / `producer_lost` 后继续持有 Workspace，第二个 Session 收到 `workspace_busy`；另一个复合命令必须启动真实的脱离进程，原 worker 死亡后它仍存活、文件持续增长，同时原 Workspace 的精确 holder 保持封锁；第三个 Workspace 在前两者阻塞期间仍能完成文件操作。

恢复通过独立 JVM 调用真实运维入口：inspect 原绑定及 generation、prepare 精确持有的租约、停止测试拥有的 worker 和潜在写入者，再提交私有的静止声明。随后使用同一证据文件重试 complete。SQL 必须证明原租约被移除、原绑定已退役，新 Session 必须在恢复的 Workspace 中实际写入文件。原标记始终只有一个 `x`，恢复本身不得再次调用模型。

成功输出包含 `HOSTED_OPERATOR_RECOVERY_OK` 和带身份信息的 `OPERATOR_RECOVERY` 记录。检查失败时保留 Surefire 报告和进程输出。本验收不证明任意逃逸进程、外部重启源、跨宿主恢复或原不确定回合已经完成；运维声明仍是[恢复流程](../../../docs/users/hosted-workspace-recovery.zh-CN.md)规定的信任边界。

2026-10-09 的生产基线为 `669b2f0f91b0c787f7d8a26971c7c34210b935e1`，未修改的 CLI bundle SHA256 为 `11db529ca76a62e3b19c95269da45583ffb6b820b5e9619ae38bb973661c5c2d`。两次运行都使用独立本地虚拟机中的 Ubuntu 24.04 arm64、Linux 6.8.0-146-generic、Java 21.0.12.1 和 Node 22.23.3。MySQL 8.4.11：1 项测试、0 failures、0 errors、0 skipped，21.17 秒；MariaDB 11.4.13：1 项测试、0 failures、0 errors、0 skipped，23.84 秒。两次均输出 `HOSTED_OPERATOR_RECOVERY_OK`。

两次脱离进程场景均在原 worker 被杀后记录 `escapedWriterLive=true`，holder 仍保持封锁。两个恢复均完成并产生新 binding，两个替代 Session 实际写入 `available`，原标记始终为 `x`；运维重试与不重放断言也通过。此次选择 legacy saved-result Shell profile。`W1_PHYSICAL_GUARD=false`，不能据此证明 W1 挂载/备份隔离或 H3 background/Monitor publication、重启和 drain 行为。

</details>
