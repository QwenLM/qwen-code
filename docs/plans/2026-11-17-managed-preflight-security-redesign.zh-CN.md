# Managed preflight 安全语义重设计（切片 6，剩余子项）

[English](2026-11-17-managed-preflight-security-redesign.md) | [简体中文](2026-11-17-managed-preflight-security-redesign.zh-CN.md)

## 状态与范围

`docs/design/2026-11-12-managed-agent-preproduction-convergence.md` 中切片 6（preflight 简化）剩余三个子项的自包含实施计划。第四个子项——规范化 Broker URL 入口——已以提交 `7b345783717` 落在分支 `refactor/managed-agent-preflight-simplification`（Java `HarnessBrokerUrl` 改用 `InetAddress` 规范化加 canonical 形状门；Node 解析器 `packages/cli/src/serve/managed-runtime-broker-url.ts` 套用同一门；两者共用同一份更新后的 fixture）。

下面三个子项都触及安全语义，且被大型逐判定钉死的测试套件约束。它们是重设计，不是快赢。逐个做，每个作为独立干净提交（最好独立 PR），在每一个提交处保持钉死套件全绿。不要合成一个大 diff。

在同一 worktree 目录新开一个会话（不要 `--resume` 那条超大源会话）；读本文档即可开工。编辑前对当前树核实每一处行号锚点——行号会漂移。

## 基线与本地验证

JDK 21 与 Maven >= 3.8.9。使用任务隔离的 Maven 仓库，并先从本 checkout 安装 sibling SDK：

```
# 普通拷贝跨平台可用；有条件时优先写时克隆：
#   macOS (APFS): cp -Rc ~/.m2/repository /tmp/preflight-m2
#   Linux (GNU):  cp -R --reflink=auto ~/.m2/repository /tmp/preflight-m2
cp -R ~/.m2/repository /tmp/preflight-m2
mvn -Dmaven.repo.local=/tmp/preflight-m2 -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
```

在 `packages/managed-agent-server` 下用 `-Dmaven.repo.local=/tmp/preflight-m2` 跑聚焦 Java 测试，并始终跑两个 Checkstyle execution（`checkstyle:check checkstyle:check@runtime-broker-checkstyle`）。本工作的钉死套件为 `ServerEnvironmentTest`、`ManagedAgentPreflightTest`、`ServiceAccountTest`、`ResolvedConfigurationTest`、`ExternalRuntimeConfigurationTest`（均在 `verification/src/test/java/com/alibaba/qwen/code/managedagent/preflight/`）。`ManagedAgentPreflightTest` 部分用例会拉起真实 Node worker，需要已构建的 `packages/core/dist` 与 `packages/cli/dist`；选择这类用例前先 `npm run build`，或留归 CI 并如实说明。完整门禁（unit/H2、SpotBugs、MySQL、Hosted）归 CI；分别报告本地通过/失败/跳过与 CI 缺口。所需 CI 门禁通过前验收待定。

## 子项 A —— 用 Spring ConfigData 替换 StackWalker 格式嗅探

当前锚点：`ServerEnvironment.java` 的 `reader(Path)` 用 `StackWalker.getInstance(RETAIN_CLASS_REFERENCE)` 识别是哪个 `PropertySourceLoader` 打开文件，把格式记进 `LookedUp` property source；`prepare()` 安装该 loader。发现的文件/格式供给 `files()`、`configurationFiles()`、`sourceFiles()`、`sourceConfigurations()`、`hidden()`、`failure()`。

目标：改从 Spring ConfigData API / 已加载 property source 的 origin 推导同样的「Spring 查找了哪些文件（含不存在的）以及以哪些格式」信息，不再嗅探调用栈，且不改变任何可观察判定。

约束：`ServerEnvironmentTest` 钉死精确文件列表、格式集合、profile 变体、wildcard/configtree 展开、隐藏目录检测与失败措辞（含不可读文件与 YAML 行/列措辞）。每一条都必须保持绿。若 ConfigData 无法复现某条钉死（例如 Spring 查找但未加载的文件），对该部分保留现有 `LookedUp` 机制，而不是丢弃钉死。

验收：`ServerEnvironmentTest` 全绿；两个 Checkstyle execution 干净；`--check` config 行行为不变。

## 子项 B —— 移除 YAML/注释 AST，但保留按值秘密检测

当前锚点：`ManagedAgentPreflight.java` 的 `YamlWalk`（SnakeYAML 节点遍历）加 `yamlSecret`、`commentSecret`、`comments()`、`holdsSecret`、`declaresSecret`。按值检测在 `valueSecret`（URL userinfo 口令与任意键下 `?password=`/`?token=` 参数）与 `secretProperty`（键名后缀）。

目标：删除 SnakeYAML AST 遍历与注释/路径机器，换成更简单的扫描器，仍能标记 (1) 任何持有秘密的值（URL userinfo、`?password=`/`?token=`），(2) 任何命名秘密的已声明键，(3) 取消注释后会命名或持有秘密的被注释设置。仅按键名扫描不可接受：会漏掉如 `spring.datasource.url` 内的凭据、丢失 `chmod 600` 告警（#17139 评审的锁定约束 R1-5）。

约束：`ServerEnvironmentTest.readsACommentAsTheSettingItWouldBeUncommented` 与 `judgesWhatACommentHoldsHoweverItIsWritten` 钉死约 100 条 YAML/properties/XML 的精确 WARN/PASS 判定，覆盖复杂 YAML 键、set、pairs、merge、alias、UTF-16/BOM、转义标记与散文。替换必须复现每一条判定，包括散文与空/无绑定容器的 PASS 用例。优先复用 Spring 自己的 property-source loader 展平 YAML/properties/XML（`declaresSecret` 对 properties/XML 已如此做）加现有 `valueSecret`/`WRITTEN_SETTING` 注释启发式，而不是手写新解析器。

验收：两个钉死测试方法全绿；`ManagedAgentPreflightTest` 秘密文件用例绿；两个 Checkstyle execution 干净；保留 `chmod 600` 告警。

## 子项 C —— 以服务身份实测 ServiceAccount 访问

当前锚点：`ServiceAccount.java` 的 `can()`/`allows()` 在用户态模拟 POSIX owner/group/other 位与符号链接遍历（最多 40 链接），因为 preflight 常以 root 运行、却必须为另一个配置的服务账号判断访问。`lookup()` 外壳调用 `id`。

目标：按切片 6 设计，以真实服务身份而非 root 用户态 `namei` 模拟来判断文件访问。

约束与 caution：`ServiceAccountTest` 钉死 owner/group/other 优先级、目录 enter 与 read 之别、链接两侧目录的遍历、40 链接上限、缺文件与 loop 行为、root 语义。真实身份检查通常需要以该 uid 运行探针（只有 root 能降权），平台相关，且非 root 操作者可能做不到。需决定并记录 fallback：当进程无法承担服务身份时，保留现有模拟（它是唯一可移植答案），而不是静默返回错误判定。不要为新实现通过而弱化钉死断言。

验收：`ServiceAccountTest` 在 macOS 与 Linux 全绿；两个 Checkstyle execution 干净；不可读文件/隐藏目录 config 行保持现有措辞。

## 顺序与横切规则

先 A、再 B、后 C（A 最机械、C 最平台敏感）；各自独立可交付。任一子项落地时同步双语收敛设计文档（两种语言都标 Done）。保留全部 C 类不变量与模块 AGENTS.md 评审规则。绝不为通过验证而关闭门禁或删除钉死；若某条钉死无法保留，停下来暴露冲突，而不是落一个红或弱化状态。
