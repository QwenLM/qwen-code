# 参考分发产物的升级命令

[English](2026-10-25-managed-agent-upgrade-command.md) | [简体中文](2026-10-25-managed-agent-upgrade-command.zh-CN.md)

状态：随本次改动提出并实现。

## 问题

部署指南把升级写成七个手工步骤。在 systemd 布局下，运维需要自己弄清楚几件事：

- 部署由哪些文件组成；
- 如何回收 `KillMode=process` 留下的 Runtime worker；
- 如何备份 MySQL 而不把密码放到命令行上；
- 如何切换版本，使回滚只需一步。

还有三个问题只在真实主机上才会出现：

- **schema 基线被原地重写。** 在首个正式版之前，版本可能原地重写 Flyway 基线，`ManagedSchema` 里写明了"Keep V1 until the first formal release"。因此，两个 manifest 都写 schema 版本 `1` 的版本，schema 可能并不一致。新服务端在启动时会拒绝旧数据库。运维要到停服、备份、安装之后才会发现，服务随后陷入反复重启。
- **预检放过服务端会拒绝的数据库。** `--check` 的 `database` 行只比较版本字符串。它会放过服务端会拒绝的数据库，却让首次启动本可迁移的旧数据库报 FAIL。
- **正常停止后 unit 显示失败。** JVM 收到 `SIGTERM` 并正常关闭后以 143 退出，控制面 unit 不把它算作成功，因此每次停止都会让 unit 处于 failed 状态。

## 目标

- 新分发产物中的一条命令分阶段执行升级，运维可以逐步跟随、随时停下并接着执行。
- 每个阶段重新读取部署状态，上一阶段留下的状态不符合预期时拒绝执行。
- 新版本无法服务现有部署时，命令在停止任何服务之前就发现。
- 备份包含回滚所需的内容，旧版本保持安装状态。
- `--check` 在 schema 上与服务端的判断一致。

## 非目标

- systemd 以外的布局。指南为它们保留手工步骤。
- 停止入口流量、安装 Qwen Code、修改环境文件或 unit 文件。命令只在对应位置打印这些步骤。
- 自动回滚。回滚步骤写在指南中。
- 在首个正式版之前改变原地修改基线的做法。

## 设计

### 阶段

`bin/qwen-managed-agent-upgrade <phase>` 是与 bootstrap 并列的 Node.js 脚本，以 root 身份从解压后的新分发产物中运行。它通过 `systemctl show` 读取两个 unit：从服务端 unit 的 `ExecStart` 找到已安装的版本，从 `EnvironmentFiles` 和 `Environment` 属性读取配置。

- **`check`**
  - 前置条件：无。
  - 执行：每项输入打印一行，再打印计划；任一 FAIL 时退出码为 1。
- **`stop`**
  - 前置条件：`check` 没有 FAIL。
  - 执行：
    1. 停止控制面。
    2. 其 cgroup 中仍有进程时执行 `systemctl kill --kill-whom=all`，并等到 cgroup 为空。
    3. 停止 Harness。
- **`backup`**
  - 前置条件：两个 unit 都已停止，服务端 cgroup 为空。
  - 执行：
    - 用 `mysqldump` 写出 `database.sql`，凭据放在临时选项文件中传入；
    - 写出 `runtime-state.tar` 和 `configuration.tar`；
    - 最后写入 `backup.json`，记录前面这些文件；
    - 任一步失败时删除已写出的内容。
- **`install`**
  - 前置条件：两个 unit 都已停止；备份仍与当前部署相符；`check` 没有 FAIL。
  - 执行：
    1. 把新版本复制到 `<分发路径>-releases/<version>`，并校验副本。
    2. 复制已安装版本 `config/` 中的运维文件。
    3. 用一次 `rename` 替换分发链接。第一次运行改为把已安装的目录移入版本目录，再在原位置放一个链接。
- **`start`**
  - 前置条件：新版本已安装；服务端 unit 已停止；Broker 配置已修改。
  - 执行：
    1. 启动 Harness 并等待其端口就绪。
    2. 通过 `systemd-run`，按 unit 的用户、工作目录和环境运行已安装版本的 `--check`。
    3. 通过后才启动控制面，并等待 `/actuator/health` 报告 `UP`。
- **`verify`**
  - 前置条件：两个 unit 都在运行。
  - 执行：
    - 以同样方式运行 `--check --online`；
    - 读取 actuator；
    - 指定 `--tenant` 时，读取一个 Session 及其 Item；
    - 指定 `--turn` 时，在新 Session 中运行一个 Turn，这会调用模型。

各阶段不保存状态文件，而是每次重新读取 unit、文件和链接，因此因崩溃中断的阶段可以直接重新运行。再次运行 `stop` 不会重复已经完成的操作；`install` 会复用校验和匹配的副本。

### check 的各行

| 行             | FAIL                                                                | WARN                                                             |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `distribution` | 有文件与 `SHA256SUMS` 不符                                          |                                                                  |
| `deployment`   | unit 未加载，或服务端启动的不是分发产物中的启动脚本                 |                                                                  |
| `version`      | 版本相同或更旧                                                      |                                                                  |
| `database`     | 已安装数据库执行过的脚本被修改或删除                                | 有新脚本要执行；无法读取 jar                                     |
| `java`、`node` | 低于 manifest 的最低版本，或找不到                                  | 版本范围无法解析                                                 |
| `qwen-code`    |                                                                     | Harness 运行的版本与 manifest 不同                               |
| `harness-env`  |                                                                     | 存在 `QWEN_HOSTED_HARNESS_BROKER_ARGS`，或 Broker token 设了两份 |
| `config`       | 已安装版本的 `config/` 中有非文件项                                 |                                                                  |
| `unit-files`   |                                                                     | 两个版本之间 unit 模板有变化                                     |
| `layout`       | 版本目录位于分发产物内部，或与 install 要移动的目录不在同一文件系统 |                                                                  |
| `backup-tools` |                                                                     | `PATH` 上没有 `mysqldump`                                        |

`database` 行从两个服务端 jar 中读取 Flyway 脚本：取 manifest 中的控制面组件，读取 `BOOT-INF/classes/db/**/V*__*.sql` 或 `U*__*.sql` 条目。一个简短的 zip 读取器沿中央目录找到条目，再用 `zlib` 解压，因此早于本改动的版本也能比较。决定这一行结果的是脚本内容，而不是 manifest 中的版本字符串：即使两个 manifest 都写版本 `1`，脚本有变化也会报 FAIL。

`harness-env` 报 WARN 而不是 FAIL：备份必须保留旧版本读取的文件，所以修改发生在 `backup` 之后；修改完成之前，`start` 会拒绝执行。

### 备份是否仍然有效

`backup.json` 记录五项内容：

- 已安装版本和目标版本；
- boot ID；
- 服务端 unit 的 `ActiveEnterTimestampMonotonic` 与 `InactiveEnterTimestampMonotonic`；
- 每个文件的大小和 SHA-256。

其中任一项变化，`install` 都会拒绝这份备份。具体来说，重启会改变 boot ID，备份之后的任何一次启动都会改变上述时间戳之一。

### 预检的变化

- `database` 行按 Flyway 顺序比较版本：
  - schema 更旧时报 WARN，说明首次启动会迁移它；
  - schema 更新时报 FAIL。
- 版本正好是 manifest 写明的版本时，`database` 行会运行服务端启动时同样执行的 `ManagedSchema.validate`，数据库不匹配就报 FAIL。

### unit 模板

控制面 unit 增加 `SuccessExitStatus=143`。`check` 会把模板变化报为 WARN，由运维同步到已安装的 unit。

## 兼容性与风险

- **分发产物布局。** 分发产物新增两个文件：`bin/qwen-managed-agent-upgrade` 及其 `.mjs` 脚本。第一次 `install` 会把 `/opt/qwen-managed-agent` 变成链接，unit 中的路径不变。
- **`--check` 的结果。**
  - 数据库更新时仍报 FAIL；更旧时由 FAIL 改为 WARN。
  - 数据库处于 manifest 写明的版本、但服务端会拒绝时，现在报 FAIL。
- **旧版本。** 命令会读取早于它的版本：它们的 manifest、服务端 jar 和 unit 模板，但不运行这些版本的任何代码。
- **命令不覆盖的内容。** `backup` 覆盖数据库、Runtime 状态和配置，不备份 Workspace；升级过程中 Workspace 保持原样。

## 验证计划

- **单元测试（`scripts/tests/managed-agent-upgrade.test.mjs`）。** 使用伪造的 `systemctl`、`systemd-run` 和 API，在虚拟时钟上运行，配合真实的文件、`tar` 和 zip 归档。覆盖：
  - 环境文件、`systemctl show` 输出、版本号、JDBC URL 和 jar 中脚本的解析；
  - check 的每一行；
  - 每个阶段的拒绝条件与执行步骤。
- **变异测试。** 脚本中的判断 21 个变异，预检改动 4 个变异。
- **预检单元测试：**
  - Flyway 顺序；
  - 校验钩子。
- **真实主机端到端**（systemd 257、MySQL 8.4，真实 Hosted Harness 配合伪造模型）。旧版本按 `systemd/README.md` 的方式安装，并在服务端 cgroup 中留一个替身 worker。
  - **兼容的升级：** 跑完所有阶段，并验证：
    - 在服务运行时或阶段顺序不对时的拒绝；
    - 恢复到全新 MySQL 的演练；
    - `verify --turn`；
    - 文档中的回滚步骤。
  - **基线被原地重写：** `check` 报 FAIL，`stop` 拒绝执行。
  - **同一主机状态下的预检 A/B：**
    - 本改动之前的版本放过服务端会拒绝的数据库；
    - 本版本让该数据库报 FAIL。

## 验收标准

- 运维用六条命令加上 `check` 打印的人工步骤，即可升级一个 systemd 部署。
- 新版本无法服务的升级在 `check` 阶段就报 FAIL，不会停止任何服务。
- 回滚可以从一份备份恢复数据库、Runtime 状态和配置，并切回仍然保留在本机的旧版本。

## 后续工作

- 首个正式版冻结基线后，schema 变更以新的 Flyway 版本发布；届时 `database` 行会把这类升级报为 WARN。
- 清理运维不再需要的版本，保留当前安装的版本和上一个版本。
