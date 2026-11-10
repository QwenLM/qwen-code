# 对象存储插件

[English](README.md) | [简体中文](README.zh-CN.md)

这个独立示例只依赖同版本的 `qwen-managed-agent-contracts`（provided scope）。它实现 `example-local`，要求文件系统支持原子硬链接和目录 fsync。示例演示 SPI 打包方式；部署者仍需验证文件系统和故障语义。所有需要访问同一批对象的 Server、Broker 和维护进程必须共享持久目录。单个容器的本地目录不满足多主机部署要求。

## 实现与打包

实现 `ImmutableObjectStoreFactory` 和 `ImmutableObjectStore`，在 `META-INF/services/com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStoreFactory` 中登记 factory 的完整类名。provider 名称必须唯一且为小写标识符。factory 在创建客户端前校验配置；加载器校验创建出的存储实例并负责关闭。

稳定身份必须包含 provider 和物理命名空间，凭据轮换及进程重启不能改变它，且其中不能包含凭据。更换 Bucket、region 或命名空间应改变身份。每个外置资源持久化 `store_id`；身份不一致时拒绝访问，避免到另一个后端解析旧 key。

`putIfAbsent` 只执行一次物理创建，不能覆盖已有对象，也不能暴露部分正文。禁止隐藏写入重试。可能完成创建后丢失响应时返回 `WRITE_OUTCOME_UNKNOWN`，由 Server 对原 key 对账。分别报告 `ALREADY_EXISTS`、`NOT_FOUND`、`ACCESS_DENIED` 和 `UNAVAILABLE`。每次后端请求、重试和流式处理期间执行传入的 guard；guard 抛出异常必须中止工作。创建成功后正文完整可读；删除只针对指定 key，不存在视为成功。所有正常和异常路径都需关闭流及连接。

在此示例目录执行，前提是匹配版本的 contracts 已安装到隔离 Maven 仓库：

```bash
mvn -Dmaven.repo.local=/path/to/task-m2 package
```

插件不应再打包一份 contracts 或 Spring。部署 classpath 必须包含插件自身的运行时依赖。自动化插件测试也会在只有 contracts 的编译 classpath 下编译示例，再在没有 Spring 和 OSS 的 classloader 中验证 JAR。

## 配置与启动

下面所有布尔开关默认关闭。Server、Broker 和维护工具使用相同 provider 及配置；`example-local` 不需要任何 OSS 配置。

```yaml
qwen:
  managed-agent:
    object-store:
      provider: example-local
      provider-options:
        directory: /srv/qwen/objects
      resource-writes-enabled: false
      gc-enabled: false
      deletion-grace: 24h
      journal-cold-storage-enabled: false
      journal-eviction-enabled: false
```

内置 provider 为 `aliyun-oss`，配置项为 `endpoint`、`region`、`bucket`，凭据沿用现有阿里云环境变量凭据 provider。endpoint 使用固定 region 的 HTTPS 地址（如 `https://oss-cn-hangzhou.aliyuncs.com`）；Bucket 必须私有且从未开启版本控制。这些限制属于该适配器，不属于公共 SPI。显式配置的 provider 未安装、重复注册或配置不完整时启动失败。未选择通用 provider 时，仍兼容原有 Tool Publication OSS 配置。

普通 Java 发行包通过 `-cp` 加入 contracts、应用、插件及所有依赖。Spring Boot 可执行 JAR 必须显式使用 `PropertiesLauncher`：

```bash
java \
  -Dloader.path=/opt/qwen/plugins/managed-local-object-store-0.1.0-alpha.jar,/opt/qwen/plugins/dependencies/ \
  -Dloader.main=com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication \
  -cp /opt/qwen/qwen-managed-agent-server-exec.jar \
  org.springframework.boot.loader.launch.PropertiesLauncher
```

将可执行 JAR 路径替换为实际构建产物。`java -jar` 不会自动加载任意插件目录。只在启动时发现插件，不支持热加载、自动下载或在线切换后端。

独立工具复用同一 launcher/classpath，将 `loader.main` 改为 `com.alibaba.qwen.code.managedagent.maintenance` 下的 `WorkspaceRecoveryMain`、`WorkspaceMigrationMain`、`WorkspaceCsiRuntimeMain` 或 `WorkspaceCsiWorkerAckMain`。保留工具文档要求的参数、JDBC 配置和离线检查。这些入口从 Java system properties 或环境变量读取 provider 配置，不会加载 Spring Boot 的 `application.yml`。例如：

```bash
java \
  -Dqwen.managed-agent.object-store.provider=example-local \
  -Dqwen.managed-agent.object-store.provider-options.directory=/srv/qwen/objects \
  -Dloader.path=/opt/qwen/plugins/managed-local-object-store-0.1.0-alpha.jar \
  -Dloader.main=com.alibaba.qwen.code.managedagent.maintenance.WorkspaceRecoveryMain \
  -cp /opt/qwen/qwen-managed-agent-server-exec.jar \
  org.springframework.boot.loader.launch.PropertiesLauncher inspect /path/to/request.json
```

只读取 SQL 操作账本的 inspect 不打开后端。capture、verify 和恢复路径与服务使用同一 factory 实现，并负责关闭实例。

## 契约验证与上线

在可丢弃的命名空间运行可复用契约检查，classpath 包含示例 JAR、被验证的 provider 及其依赖：

```bash
java \
  -Dobject-store.option.directory=/tmp/qwen-object-contract \
  -cp /path/to/contracts.jar:/path/to/managed-local-object-store-0.1.0-alpha.jar \
  example.ObjectStoreContractCheck example-local
```

替换 provider 和 `object-store.option.*` 即可验证其他实现。检查覆盖并发创建、禁止覆盖、输入流中断、带授权检查及长度边界的读取、重开后的存储身份和幂等删除。它创建唯一测试 key 并删除已完成对象，不模拟后端进程崩溃、PUT/DELETE 丢响应、延迟可见或网络重试期间授权失效。实际后端必须补充这些故障门禁，内存 provider/H2 测试不能证明生产资格。

启用 `resource-writes-enabled` 前先部署 storage version 6 reader。CSI 外置资源要求 `csi-files-retirement/4`。GC 独立开启。先启用 `journal-cold-storage-enabled`，只上传和验证 pack，保留 SQL 正文；资格验证后再开启 `journal-eviction-enabled`。自动候选要求连续冷却七天且 journal 正文至少 32 MiB。关闭新写入和冷藏后，读取、对账、热化及独立开启的 GC 继续运行。回滚使用兼容二进制并关闭这些开关；旧 reader 无法服务已有外置数据。

引用关系、租约、epoch 和验收标准见[设计文档](../../../../docs/design/2026-11-10-managed-object-storage.zh-CN.md)。
