# Reference 发行包的 admin 启动脚本

[English](2026-10-23-managed-agent-admin-launcher.md) | [简体中文](2026-10-23-managed-agent-admin-launcher.zh-CN.md)

状态：已提出，并在同一变更中实现。

## 问题

server 有十二个离线维护入口，包括 Workspace storage 注册、Workspace 迁移、恢复，以及各条 CSI 命令。reference 发行包只为其中的 Hosted Shell 恢复命令提供了启动脚本。其余入口在文档中都写成 `java -Dloader.main=<class> -cp target/<jar> org.springframework.boot.loader.launch.PropertiesLauncher …`，从模块构建中运行。

对已经安装 reference 发行包的运维来说，这种写法用不了：

- 有些示例引用的是带 classifier 的 jar（例如 `-csi-runtime.jar`），而发行包并不包含它们。
- 示例中的路径位于 `target/` 下，只有源码目录中才有。
- 运维还得从 README 中复制完整的类名。

## 目标

- 发行包中用一个启动脚本，以简短的命令名运行所有维护入口。
- 除了发行包已经带有的 server jar，不需要额外的 jar。
- 能列出所有命令，并像其他启动脚本一样加载发行包的配置。
- 入口被改名或删除时，打包失败，而不是发出一条无法启动的命令。
- 文档同时给出发行包写法和模块构建写法。

## 非目标

- 改变任何入口的参数或行为。
- 从模块构建中删除带 classifier 的 jar，或从发行包中删除 operator-recovery 的 jar 和启动脚本。
- 让任何命令可以在线运行。每条命令仍是有自身前提条件的离线流程。

## 设计

### 命令

`scripts/package-managed-agent-reference.mjs` 导出 `ADMIN_COMMANDS`，每一项包含命令名、入口类和一行简介。

| 命令                     | 入口                                           |
| ------------------------ | ---------------------------------------------- |
| `storage-registration`   | `maintenance.WorkspaceStorageRegistrationMain` |
| `workspace-recovery`     | `maintenance.WorkspaceRecoveryMain`            |
| `workspace-migration`    | `maintenance.WorkspaceMigrationMain`           |
| `maintenance-recovery`   | `maintenance.WorkspaceMaintenanceRecoveryMain` |
| `operator-recovery`      | `maintenance.WorkspaceRecoveryCommand`         |
| `csi-registration`       | `maintenance.WorkspaceCsiRegistrationMain`     |
| `csi-protection`         | `maintenance.WorkspaceCsiProtectionMain`       |
| `csi-session`            | `maintenance.WorkspaceCsiSessionMain`          |
| `csi-runtime`            | `maintenance.WorkspaceCsiRuntimeMain`          |
| `csi-retirement`         | `maintenance.WorkspaceCsiRetirementMain`       |
| `csi-worker-ack`         | `maintenance.WorkspaceCsiWorkerAckMain`        |
| `resident-retirement`    | `maintenance.ResidentWorkspaceRetirementMain`  |
| `resolved-configuration` | `preflight.ResolvedConfiguration`              |

所有类都位于 `com.alibaba.qwen.code.managedagent` 包下。

### 启动脚本

打包脚本写出 `bin/qwen-managed-agent-admin`，它是一个 POSIX shell 脚本：

- 与 server 启动脚本一样，当 `config/application.yml` 存在且未设置 `SPRING_CONFIG_ADDITIONAL_LOCATION` 时，把该变量设为这个文件。
- 不带命令或使用 `help` 时，打印所有命令及其简介后以 0 退出，不启动 Java。
- 未知命令把同样的列表打印到标准错误，并以 2 退出。
- 已知命令运行 `java -Dloader.main=<class> -cp lib/<server jar> org.springframework.boot.loader.launch.PropertiesLauncher <arguments>`。
- 它不做任何环境变量映射。每个入口继续读取自己的凭据，部署文档中列出了这些变量：Workspace 命令读取 `W1_JDBC_*`，CSI 命令读取 `K2_JDBC_*`，`operator-recovery` 和 `resident-retirement` 会启动服务端的 Spring 配置，使用控制面的 Spring 数据源 `SPRING_DATASOURCE_*`。

模块构建中每个带 classifier 的 jar 都是同一个应用，只是换了 main class 重新打包，因此可执行的 server jar（发行包中的 `lib/<server jar>`）已经包含所有入口。

### 打包检查

写出启动脚本之前，打包脚本逐一读取各个类在 `packages/managed-agent-server/src/main/java` 下的源文件；文件不存在或其中没有 `public static void main(String` 时，打包失败。

### 文档

- 部署文档新增"维护命令"一节。
- server README 中 storage 注册和 Workspace 迁移两节，以及 K2 resident README 中的保护和退役命令，都先给出 `bin/qwen-managed-agent-admin` 的写法。
- K2 README 中模块构建的命令改用包含所有入口的可执行 server jar（`-exec.jar`），不再引用 `-csi-runtime` jar。
- reference 发行包设计文档的目录结构中加入该启动脚本。

## 兼容性与风险

- 发行包新增一个启动脚本，没有新增 jar。现有的启动脚本、jar 以及文档中模块构建的命令都继续可用。
- 这些命令名成为发行包运维接口的一部分，以后改名需要写明兼容性说明。
- server README 已经以这种方式（从 server jar 通过 `PropertiesLauncher` 启动）说明 storage 注册，因此没有引入新的启动方式。

## 验证计划

- 打包测试：
  - 在 `PATH` 中放一个假的 `java`，验证每条命令都映射到对应的类，并原样传递参数；
  - `help` 列出所有命令及其简介，且不启动 Java；
  - 未知命令以 2 退出；
  - 类不存在或没有 main 方法时，打包失败；
  - 每个类都存在于真实的源码树中且带有 main 方法，命令名不重复。
- 使用打包后的发行包和真实 server jar 的端到端测试：
  - 每条命令不带参数运行时，都进入了它自己的入口，由该入口给出的用法错误证明；
  - `storage-registration inspect` 通过发行包的配置读取一个已完成迁移的 MySQL 数据库。

## 验收标准

- 运维可以在 reference 发行包中，以 `bin/qwen-managed-agent-admin <command>` 运行每一个维护入口。
- 入口被改名或删除时，打包失败。

## 后续工作

- 等模块构建的文档不再引用带 classifier 的 jar 之后，删除这些 jar。
