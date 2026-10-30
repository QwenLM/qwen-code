# Bootstrap 服务账号与 MySQL 初始化

[English](2026-10-23-managed-agent-bootstrap-service-account.md) | [简体中文](2026-10-23-managed-agent-bootstrap-service-account.zh-CN.md)

状态：已提出，并在同一变更中实现。

## 问题

`bin/qwen-managed-agent-bootstrap` 写出的 `harness.env`、`server.env` 和 `application.yml` 都归运行它的用户所有，权限一律为 `0600`。systemd 布局要求的属主不同：`harness.env` 和 `application.yml` 归服务账号所有，`server.env` 为 `0640 root:qwen-managed-agent`。按 `/etc` 布局以 root 运行 bootstrap 之后，运维还得手工修改三个文件的属主和权限；漏改一个，服务就会因为读不到文件而拒绝启动。

数据库同样留给了运维。bootstrap 写入的是 `SPRING_DATASOURCE_PASSWORD=replace-me`；建库、建账号和 `performance_schema` 授权的语句只出现在 server README 开发章节的一段注释里。这段注释还提到了 `skip-name-resolve` 的坑：只建在 `localhost` 上的账号，永远匹配不到来自 `127.0.0.1` 的 TCP 客户端。

最后，预检以运行 `--check` 的进程身份检查配置文件和凭据文件是否可读。以 root 运行时所有文件都可读，因此 `config` 和 `credentials` 行会对服务账号读不到的文件报 PASS，等到服务启动时才被拒绝。

## 目标

- 一条 bootstrap 命令就生成 systemd 布局所需的文件，并直接带上最终的属主和权限。
- bootstrap 生成数据库密码，以及创建数据库和账号的 SQL。
- 无论由谁运行预检，它都按服务账号检查文件访问权限。
- 不打印任何 secret。

## 非目标

- 创建服务账号，或对 MySQL 执行 SQL。bootstrap 只写文件。
- 检查 ACL、SELinux 标签或 capability。文件访问权限只根据属主和权限位判断。
- 按服务账号检查 Workspace 和 Runtime 状态目录的访问权限。现有各行仍以运行预检的进程身份检查它们。

## 设计

### `--service-user`

`--service-user NAME` 要求以 root 身份运行 bootstrap，否则拒绝执行。名称必须是可移植的用户名（`[a-z_][a-z0-9_-]{0,31}`），因为它会不加引号地写入 `server.env`。bootstrap 用 `id` 读取账号的 uid、主组 gid 和所属组；账号不存在时拒绝执行。

传入该选项时：

| 文件                    | 属主            | 权限   |
| ----------------------- | --------------- | ------ |
| `harness.env`           | 账号 : 账号的组 | `0600` |
| `application.yml`       | 账号 : 账号的组 | `0600` |
| `server.env`            | root : 账号的组 | `0640` |
| `mysql-setup.sql`       | root : root     | `0600` |
| 由 bootstrap 新建的目录 | root : 账号的组 | `0750` |

每个文件先写到临时文件名，设好属主和权限后再重命名，因此文件不会以其他属主出现。已存在的目录保持不变，因为它可能是共享目录，例如 `/etc`。随后 bootstrap 检查账号能否进入内核到达该目录途中经过的每一个目录，以及该目录本身。它按内核解析路径的方式逐段遍历：遇到符号链接时加入其目标路径上的目录，链接所在的目录也仍在检查之列。与内核一致，属主适用属主位，组成员适用组位，其余适用 others 位。只要有一级目录挡住账号，bootstrap 就不写任何文件，并给出该目录。本次刚创建的目录会保留，且已设好最终的属主和权限，修复后重新运行会直接使用它。

`server.env` 以 `QWEN_MANAGED_AGENT_SERVICE_USER` 记录该账号。不传该选项时，除了数据库密码和 SQL 文件，bootstrap 的行为与以前相同。

### MySQL 初始化

bootstrap 生成一个 64 位十六进制的随机数据库密码，写入 `server.env` 的 `SPRING_DATASOURCE_PASSWORD`，并用同一密码写出 `mysql-setup.sql`：

- `CREATE DATABASE qwen_managed_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`；
- 为 `'qwen'@'localhost'` 和 `'qwen'@'127.0.0.1'` 执行 `CREATE USER`；
- 为两者执行 `GRANT ALL ON qwen_managed_agent.*`；
- 为两者执行 `GRANT SELECT ON performance_schema.user_variables_by_thread`，Flyway 的启动探测需要这项权限。

这些语句都不带 `IF NOT EXISTS`。`mysql` 客户端遇到第一个失败就停止，因此这个文件不会改动已有的数据库或账号。文件中的注释说明了如何运行它、为什么要建两个账号，以及容器中的 MySQL 需要改为给网关主机建账号。bootstrap 只打印该文件的路径，并提示运维以 MySQL 管理员身份运行后删除它。

### 预检

新增设置 `qwen.managed-agent.service-user`（`QWEN_MANAGED_AGENT_SERVICE_USER`），指明服务运行所用的账号。新增的 `service-user` 行负责解析它：

- 未设置时为 `SKIP`，文件相关的行仍按进程身份检查，与以前相同；
- 指向运行预检的账号本身时为 `PASS (this process)`，各行按进程身份检查，结果是准确的；
- `id -Gn` 能解析出另一个账号时为 `PASS`，并列出该账号的所属组；
- 账号不存在时为 `FAIL`，此时 `id -Gn` 什么也不输出。账号属于某个没有组名的组时 `id` 同样以 1 退出，但仍会输出各组，没有组名的组以数字表示，文件属性中也是这样表示的，因此预检保留这些组；
- `id` 无法运行时为 `WARN`，各行回退为按进程身份检查。

账号解析成功后，`config` 和 `credentials` 行按内核解析路径的方式遍历文件路径：账号必须能进入遍历中查找名字的每一个目录，包括到达符号链接途中的目录和链接目标路径上的目录，并且能读取该文件。判断顺序同样是属主、组、others。与内核的 `ELOOP` 一致，一条路径中超过 40 个链接时视为不可读。失败时信息为"`<path>` is not readable by `<account>`"，修复建议给出 `chown`、`chmod 600` 以及需要放行的目录。文件系统不支持 POSIX 属性时，回退为按进程身份检查。

## 失败语义

- 未以 root 运行、名称格式不对或账号不存在时传入 `--service-user`：bootstrap 在写任何文件之前以退出码 1 结束。
- 账号无法进入某一级目录：在写任何文件之前以退出码 1 结束，并给出该目录。本次运行创建的配置目录会保留。
- `QWEN_MANAGED_AGENT_SERVICE_USER` 指向不存在的账号：`service-user` 行失败，`--check` 退出码为 1。
- 服务账号读不到某个含 secret 的文件：`config` 或 `credentials` 行失败，`--check` 退出码为 1。

## 兼容性与风险

- 不传 `--service-user` 时，文件的属主和 `0600` 权限保持不变。新增的 `mysql-setup.sql` 同样为 `0600`。
- `server.env` 现在带有生成的密码，而不是 `replace-me`。使用自有数据库账号的部署像以前一样替换这一行即可。
- `server.env.example` 设置了 `QWEN_MANAGED_AGENT_SERVICE_USER=qwen-managed-agent`，与 unit 的 `User=` 一致。改用其他账号名的部署需要同时修改这两处。
- 访问检查不考虑 ACL，因此通过 ACL 共享的文件，即使账号实际可读，也可能让该行失败。随附的布局不使用 ACL。

## 验证计划

- bootstrap 单元测试：
  - 带账号与不带账号时渲染出的 `server.env`，以及完整的 SQL 语句；
  - `lookupServiceUser` 对名称、root 身份和查询失败的拒绝；
  - `accountCanEnter` 中属主、组、others 的判断顺序；
  - `directoriesToEnter` 对绝对路径和相对路径符号链接列出的目录，以及链接循环。
- 只在 root 下运行的 bootstrap 测试，账号为 `nobody`：`0700` 的上级目录会让它在写任何文件之前拒绝执行；`chmod 755` 之后，每个文件和目录都得到上表中的属主和权限。指向 `0700` 目录下某个目录的链接同样会被拒绝，报出该目录，且不写任何文件。
- `ServiceAccountTest`：真实文件上的权限位顺序、文件之上的每一级目录、符号链接两侧的目录、链接循环、文件不存在，以及一次真实的 `id` 查询。
- `ManagedAgentPreflightTest`：`service-user` 行的每种状态，以及账号读不到文件时 `config` 和 `credentials` 行失败、对文件属主则通过。
- 以 root 身份、使用新建的系统账号和 host 网络上的 MySQL 做端到端测试：
  - bootstrap 为各文件设置属主；
  - 生成的 SQL 能建好数据库，服务以该账号启动并完成一个 Turn；
  - 以 root 运行的 `--check` 通过；把 `harness.env` 改为 root 所有后 `credentials` 行失败，而仅以 root 身份检查时这一行会报 PASS。

## 验收标准

- 运行 `bootstrap --directory /etc/qwen-managed-agent --service-user qwen-managed-agent` 并执行 SQL 之后，除了 Workspace 目录，没有其他需要手工编辑的内容。
- 以 root 运行的 `--check` 能发现服务账号读不到的文件。
- bootstrap 的输出中不出现任何 secret。

## 后续工作

- 同样按服务账号检查 Workspace 和 Runtime 状态目录。
