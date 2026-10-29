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

`bin/qwen-managed-agent-upgrade <phase>` 是与 bootstrap 并列的 Node.js 脚本，以 root 身份从解压后的新分发产物中运行。它通过 `systemctl show` 读取两个 unit：从服务端 unit 的 `ExecStart` 找到已安装的版本，从 `EnvironmentFiles` 和 `Environment` 属性读取配置。它按 systemd 自己的语法读取环境文件，即 systemd `env-file.c` 中的状态机，因此密码这类值传给 `mysqldump` 时与服务收到的完全一致。用 1579 个随机文件与 systemd 257 做差分运行，没有发现任何差异。

- **`check`**
  - 前置条件：无。
  - 执行：每项输入打印一行，再打印计划；任一 FAIL 时退出码为 1。
- **`stop`**
  - 前置条件：`check` 没有 FAIL，除非新版本已经安装。那时 `stop` 是撤销一次失败的 `start` 的方式，而它所守护的比较已经做过。
  - 执行：
    1. 停止控制面。
    2. 其 cgroup 中仍有进程时执行 `systemctl kill --kill-whom=all`，并等到 cgroup 为空。它读取 systemd 给出的 cgroup：unified 层级下直接读取，cgroup v1 下读取 systemd 自己的层级；层级和 cgroup 都读不到时拒绝执行，因为读不到 cgroup 并不能证明没有 worker 在运行。
    3. 停止 Harness。
    4. 控制面显示为 `failed` 时说明原因：在 `SuccessExitStatus=143` 之前安装的 unit 每次停止后都会这样。
- **`backup`**
  - 前置条件：两个 unit 都已停止，服务端 cgroup 为空；新版本尚未安装；`backup-tools` 和 `runtime-state` 两行没有 FAIL；`--to` 是新目录，或是属于 root 的空目录。
  - 执行：
    - 用 `mysqldump` 写出 `database.sql`，凭据放在备份目录之外某个临时目录里的选项文件中传入。`--defaults-file` 让它成为唯一的选项文件，之后读取的选项文件（如 `~/.my.cnf`）无法替换凭据；
    - 写出 `runtime-state.tar`、包含版本目录之外配置的 `configuration.tar`，以及按版本目录内路径记录其中配置的 `release-config.tar`。链接形式的配置文件连同它指向的文件一起归档；
    - 最后写入 `backup.json`，记录前面这些文件；
    - 任一步失败或被信号中止时删除已写出的内容。
- **`install`**
  - 前置条件：两个 unit 都已停止；备份仍与当前部署相符；`check` 没有 FAIL。
  - 执行：
    1. 删除之前被杀掉的 install 留下的内容：部分副本、分发路径旁的 `.upgrade-<8 位十六进制>` 链接，以及将要使用的版本目录中的 `.tmp-` 运维文件。`check` 在 `layout` 行列出它们。
    2. 把新版本复制到 `<分发路径>-releases/<version>`，校验副本，并把 `SHA256SUMS` 列出的文件设为所有账号可读；任一步失败时删除副本。该位置已有目录时，只有其 `SHA256SUMS` 与新分发产物相同、且文件与之相符时才会使用，并同样把其中列出的文件设为所有账号可读，因为直接解压到那里的版本保留着解压时的权限。
    3. 复制已安装版本 `config/` 中的运维文件。
    4. 用一次 `rename` 替换分发链接。第一次运行改为把已安装的目录移入版本目录，再在原位置放一个链接；第二次 `rename` 失败时把目录移回原处。移回也失败时保留链接，并给出两条 `mv -T` 命令。
- **`start`**
  - 前置条件：新版本已安装；服务端 unit 已停止；Broker 配置已修改。
  - 执行：
    1. 启动 Harness（之前某次 `start` 留下正在运行的 Harness 时改为重启），并等待其端口就绪。
    2. 通过 `systemd-run`，按 unit 的用户、工作目录和环境运行已安装版本的 `--check`。unit 的 `Environment=` 赋值写进一个 `0600` 的环境文件传入，而不是放在 `systemd-run` 的命令行上，因为每个本地用户都能读到命令行。
    3. 通过后才启动控制面，并等待 `/actuator/health` 报告 `UP`。单次探测最多等待 5 秒。unit 退出时会被停止并报告：显示 `failed`、处于 `auto-restart` 等待，或 `NRestarts` 不为零，都算退出，因为分发的 unit 使用 `Restart=on-failure`，进程退出后 systemd 会重新运行它，而不是让它停在失败状态。重启后本能起来的 unit 也是如此：运行新版本迁移的这次启动中出现了退出，应先读日志再信任该版本，而不是在重试时放行。先探测健康再看 unit 也改变不了这一点，因为轮询每秒一次，而 `RestartSec=5s` 会让退出的 unit 在 `auto-restart` 中停留 5 秒。到 `--timeout` 仍未健康时保持运行，拒绝信息会指明 `verify` 和 `stop`。
- **`verify`**
  - 前置条件：两个 unit 都在运行。
  - 执行：
    - 以同样方式运行 `--check --online`；
    - 读取 actuator，只探测一次，这次探测可以用满 `--timeout`；
    - 指定 `--tenant` 时，在 `--turn` 创建 Session 之前读取最近的 Session 及其 Item，指定 `--actor` 时通过服务端的可信 actor 请求头以该 actor 的身份读取；
    - 指定 `--turn` 时，在新 Session 中运行一个 Turn，这会调用模型；轮询遇到 `5xx` 应答或连接中断时会继续；
    - 服务端解析出的配置为签名认证时，跳过两项 API 读取；指定了 `--turn` 时，用一行 `turn` 说明这一点。
    - 任何请求都不会超过 `--timeout`。

各阶段不保存状态文件，而是每次重新读取 unit、文件和链接，因此因崩溃中断的阶段可以直接重新运行。`SIGINT`、`SIGTERM` 和 `SIGHUP` 会删除阶段失败时本会删除的临时文件、部分备份或副本；否则 Node 收到这些信号会直接退出，不执行 `finally` 块。删不掉的文件会被列出，其余的照样删除，命令仍按该信号的退出码退出。再次运行 `stop` 不会重复已经完成的操作；`install` 会复用同一构建的副本。rename 完成、版本已经安装之后再次运行 `install`，它会在读取备份之前说明已经安装并指明下一步是 `start`：此时再做的备份会把新版本记录为要退回的版本。重新运行无法弥补的只有一个窗口：第一次 install 的两次 rename 之间发生崩溃。此时分发路径缺失，新链接以 `<分发路径>.upgrade-<后缀>` 留在旁边；每个阶段都会报告这一状态，并给出完成安装所需的 `mv -T` 命令。

### check 的各行

| 行              | FAIL                                                                                                       | WARN                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `distribution`  | 有文件与 `SHA256SUMS` 不符                                                                                 |                                                                     |
| `deployment`    | unit 未加载，服务端启动的不是分发产物中的启动脚本，新 manifest 无法读取，或 install 被中断                 |                                                                     |
| `version`       | 版本相同或更旧                                                                                             |                                                                     |
| `database`      | 已安装数据库执行过的脚本被修改或删除；可重复脚本被删除；新增的版本化脚本没有排在数据库执行过的最新脚本之后 | 有脚本要执行，包括有变化的可重复脚本；无法读取 jar                  |
| `java`、`node`  | 低于 manifest 的最低版本，或找不到                                                                         | 版本范围无法解析                                                    |
| `qwen-code`     |                                                                                                            | Harness 运行的版本与 manifest 不同;比它新的版本经运维测试过可以保留 |
| `harness-env`   |                                                                                                            | 存在 `QWEN_HOSTED_HARNESS_BROKER_ARGS`，或 Broker token 设了两份    |
| `config`        | 已安装版本的 `config/` 中有非文件项                                                                        |                                                                     |
| `unit-files`    |                                                                                                            | 两个版本之间 unit 模板有变化                                        |
| `layout`        | 版本目录位于任一分发产物内部，或与 install 要移动的目录不在同一文件系统                                    |                                                                     |
| `backup-tools`  | `--mysqldump` 指定的客户端未安装，或数据源不是单主机 MySQL URL                                             | （指定 `--skip-database` 时为 SKIP）                                |
| `runtime-state` | 无法解析服务端的配置且未传 `--runtime-state`；`--runtime-state` 不是目录                                   | 解析出的目录不存在（未配置或传 `--runtime-state none` 时为 SKIP）   |

`check` 接受后续阶段的选项，并把它们写进打印的计划，因此这些行描述的正是运维将要执行的那次运行。`stop` 和 `install` 会重复 `backup-tools` 以上的所有行；`backup` 重复最后两行。

`database` 行从两个服务端 jar 中读取 Flyway 脚本：取 manifest 中的控制面组件，读取 `BOOT-INF/classes/db/**/` 下按 Flyway 规则命名的版本化、撤销和可重复脚本。与 Flyway 一样，`V`、`U`、`R` 前缀区分大小写，`.sql` 后缀不区分。一个简短的 zip 读取器沿中央目录找到条目，再用 `zlib` 解压，因此早于本改动的版本也能比较。决定这一行结果的是脚本内容，而不是 manifest 中的版本字符串：即使两个 manifest 都写版本 `1`，脚本有变化也会报 FAIL。Flyway 会重新执行有变化的可重复脚本，因此这种情况报 WARN；可重复脚本被删除则会导致校验失败。服务端保持 `outOfOrder` 关闭，此时 Flyway 还会拒绝版本号没有排在数据库执行过的最新脚本之后的新版本化脚本，版本按各段逐一比较。读取器在 jar 中一个脚本都没找到时，视为无法读取而不是没有变化，因为没有哪个服务端会不带 schema 发布。

`harness-env` 报 WARN 而不是 FAIL：备份必须保留旧版本读取的文件，所以修改发生在 `backup` 之后；修改完成之前，`start` 会拒绝执行。

### Runtime 状态目录

Spring 会从许多地方解析 `qwen.managed-agent.runtime-broker.state-directory`：服务端 `application.yml` 所映射的变量 `QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`；Spring 默认位置和 launcher 的 `SPRING_CONFIG_ADDITIONAL_LOCATION` 中的每个配置文件；import 或 profile 引入的文件；`SPRING_APPLICATION_JSON`；系统属性；命令行参数；以及该属性在 relaxed binding 下的每种写法。本命令前几轮自己读取这份清单，并对识别出的来源拒绝执行，结果每一轮都发现有遗漏。Spring 的配置解析没有一份封闭的清单，因此命令不再自己读取。

改为由 `check` 和 `backup` 询问服务端。服务端 jar 中有一个主类 `ResolvedConfiguration`，它按 `SpringApplication` 在创建 context 之前的方式准备环境：命令行参数、进程环境，以及 class path 上的所有 environment post-processor，由它们加载配置文件、import 和 profile。随后它绑定服务端的属性，在固定前缀之后用一行打印：状态目录（与服务端一样按工作目录转成绝对路径）及其来源、认证模式和可信 actor 请求头。它不启动 context，不输出日志，也不建立任何连接。

命令通过 `systemd-run`，按控制面 unit 运行服务端的方式运行它：使用该 unit 的账号、工作目录、环境文件和 `Environment=` 赋值，以及 unit `PATH` 上的 `java`，并带上 launcher 唯一的默认值，即 `SPRING_CONFIG_ADDITIONAL_LOCATION` 未设置或为空时使用 `config/application.yml`。运行的是本版本的 jar：它被复制到服务账号能读取的位置，因此不受压缩包解压位置的影响；通过 `PropertiesLauncher` 加 `loader.main` 启动，因此没有该类的旧 jar 会直接失败，而不会启动一个服务端。`verify` 在 `install` 之后运行，使用已安装的 jar，并从同一份输出读取认证模式。admin 启动脚本以 `resolved-configuration` 命令运行同一个类，供其他布局的手工流程使用。

有两种情况留给运维处理。一是 jar 无法解析配置，例如 import 指向的文件不存在，这时服务端同样会拒绝启动。二是 `systemctl show` 打印 `ExecStart` 参数时用空格拼接且不加引号，命令无法准确地转交 unit 传给 launcher 的参数。这两种情况下，`backup` 都会拒绝执行，直到 `--runtime-state <目录>` 指明目录，或用 `--runtime-state none` 表示部署不保存 Runtime 状态。缺少数据库所引用的 Runtime 状态的备份无法一致地恢复，因此悄悄漏掉状态的备份比拒绝更糟。配置中没有指定目录时（例如未开启工具路径的部署），`backup` 不归档 Runtime 状态，并打印说明。

### 备份是否仍然有效

`backup.json` 记录以下内容：

- 已安装版本和目标版本；
- `install` 会把旧版本放在哪里；
- boot ID；
- 服务端 unit 的 `ActiveEnterTimestampMonotonic` 与 `InactiveEnterTimestampMonotonic`；
- 导出的是哪个数据库：主机、端口和库名，不含凭据；
- 每个文件的大小和 SHA-256。

其中任一项变化，`install` 都会拒绝这份备份。具体来说，重启会改变 boot ID，备份之后的任何一次启动都会改变上述时间戳之一，修改过的 `SPRING_DATASOURCE_URL` 会指向另一个数据库，而不是被导出的那个。记录中还写明了分发路径和两个 unit，因此部署指南中的回滚步骤可以从中读取每一个路径。

### 预检的变化

- `database` 行按 Flyway 顺序比较版本：
  - schema 更旧时报 WARN，说明首次启动会迁移它；
  - schema 更新时报 FAIL。
- 版本正好是 manifest 写明的版本时，`database` 行会运行服务端启动时同样执行的 `ManagedSchema.validate`，数据库不匹配就报 FAIL。

### unit 模板

控制面 unit 增加 `SuccessExitStatus=143`。`check` 会把模板变化报为 WARN，由运维同步到已安装的 unit。同步之前，升级自己执行的那次停止会让该 unit 处于 `failed`，因此 `stop` 会说明这一点，并给出改完之后可用的 `systemctl reset-failed`。

## 兼容性与风险

- **分发产物布局。** 分发产物新增两个文件：`bin/qwen-managed-agent-upgrade` 及其 `.mjs` 脚本。第一次 `install` 会把 `/opt/qwen-managed-agent` 变成链接，unit 中的路径不变。
- **`--check` 的结果。**
  - 数据库更新时仍报 FAIL；更旧时由 FAIL 改为 WARN。
  - 数据库处于 manifest 写明的版本、但服务端会拒绝时，现在报 FAIL。
- **旧版本。** 命令会读取早于它的版本：它们的 manifest、服务端 jar 和 unit 模板，但不运行这些版本的任何代码；解析配置时运行的是本版本的 jar。
- **命令不覆盖的内容。** `backup` 覆盖数据库、Runtime 状态和配置，不备份 Workspace；升级过程中 Workspace 保持原样。

## 验证计划

- **单元测试（`scripts/tests/managed-agent-upgrade.test.mjs`）。** 使用伪造的 `systemctl`、`systemd-run` 和 API，在虚拟时钟上运行，配合真实的文件、`tar` 和 zip 归档。覆盖：
  - 环境文件、`systemctl show` 输出、版本号、JDBC URL 和 jar 中脚本的解析；
  - check 的每一行；
  - 每个阶段的拒绝条件与执行步骤。
- **环境文件。** 通过 systemd 257 的 `systemd-run` 读回 1579 个随机文件，与命令的读取结果没有任何差异。
- **变异测试。** 脚本中的判断 87 个变异，预检改动 5 个变异，`ResolvedConfiguration` 及其读取的认证模式 8 个变异；后续改动又为自身增加了 33 个，为其评审增加了 12 个。
- **预检单元测试：**
  - Flyway 顺序；
  - 校验钩子；
  - `databaseCheck` 实际执行的校验，在 Flyway 迁移出的 H2 数据库上运行。
- **`ResolvedConfiguration` 单元测试**，走 Spring 自己的环境准备：launcher 配置文件中的 import、带同级键的 flow mapping、merge key、目录位置旁的 profile 文件、`SPRING_CONFIG_NAME` 选中的 properties 文件、各种环境变量写法、`SPRING_APPLICATION_JSON`、相对路径的目录、认证模式与 actor 请求头、缺失的 import，以及打印的那一行。
- **真实主机端到端**（systemd 257、MySQL 8.4，真实 Hosted Harness 配合伪造模型）。旧版本按 `systemd/README.md` 的方式安装，并在服务端 cgroup 中留一个替身 worker。
  - **兼容的升级：** 跑完所有阶段，并验证：
    - 在服务运行时或阶段顺序不对时的拒绝；
    - 恢复到全新 MySQL 的演练；
    - `verify --turn`；
    - 带反斜杠的数据库密码，旧的读取方式会丢掉它；
    - `install` 之后的 `stop`；
    - 文档中的回滚步骤，所有路径都从 `backup.json` 读取；
    - 只由行内 YAML（flow mapping）import 的文件指定的 Runtime 状态目录：由 `backup` 归档，并由回滚恢复；
    - 针对该目录另外五种来源以及 import 缺失文件的情形，分别用本命令和它的上一个版本运行 `check`；
    - `verify` 期间用 `ps` 采样，确认 `Environment=` 不出现在 `systemd-run` 的命令行上；
    - unit 停止后显示为 `failed` 时 `stop` 打印的说明，以及第二次 `install`。
  - **基线被原地重写：** `check` 报 FAIL，`stop` 拒绝执行。
  - **首次 install 中断：** 从复制到最后一次 `rename`，在十个文件系统步骤处分别 `SIGKILL`。之后再运行 `install`（`check` 给出 `mv -T` 时先执行它），留下的目录布局都与未中断的安装相同，控制面随后能启动并通过 `verify`。
  - **信号：** 导出期间向命令发送 `SIGTERM`、向其进程组发送 `SIGINT`，以及复制期间发送 `SIGTERM`，都不会留下选项文件、备份目录或部分副本。
  - **选项文件：** root 的 `~/.my.cnf` 指定另一个账号时，`--defaults-extra-file` 会以该账号连接并被拒绝；`--defaults-file` 以服务账号连接。
  - **启动后被杀掉的控制面：** 之前的模块会等满 `--timeout`，在 systemd 反复重启 unit 期间报告启动较慢；本模块在几秒内停止它。下一次 `start` 会重启前一次留下的 Harness。
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
