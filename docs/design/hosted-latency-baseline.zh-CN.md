# Hosted 延迟基线

[English](hosted-latency-baseline.md) | [简体中文](hosted-latency-baseline.zh-CN.md)

## 问题与范围

Issue #12941 要求为 A 阶段验收标准提供测量证据：Runtime 供给延迟 15 秒时，
模型输出先于就绪开始，无工具 Turn 在供给期间完成，工具 Turn 等待就绪后在
同一模型上下文中继续。现有 Hosted 故障测试覆盖真实 Broker 和 SQL 存储，
但没有记录这些时间。

本次仅新增测试基础设施。复用打包后的 Hosted Harness、Spring Session Store、
Embedded Runtime Broker 和 Workspace worker。驱动使用私有 Harness 协议，
因为公开 Managed REST 入口目前拒绝 Workspace Session。启动采用隔离的夹具
模型配置，不测量已发布配置的部署或公开 API。

## 测量设计

使用确定性的本地 OpenAI 夹具，运行两个全新 Workspace Session：`no-tool`
和 `tool`。测试专用 worker 入口等待 `runtimeProvisioningDelayMs = 15000`
后再导入打包后的 CLI。真实 Broker 供给并验证该 worker。代理仅在成功收到
warm 响应后、向 Harness 转发前记录就绪。拒绝就绪前的获取或执行。

所有耗时使用同一个 Node 单调时钟，以提交 prompt 前一刻为起点。模型首段文本
定义为代理在 provider SSE 中观察到非空 `delta.content`，排除响应头、角色和
推理片段。SQL 提交后的首段可见文本和完成时间，另从 Harness SSE 流观测。
当前工具调用文本形成 journal 记录，而非可见消息片段，因此工具 Turn 的可见
文本可能晚于就绪。

分别记录工具请求结束、就绪等待（工具请求结束到 warm 响应）、获取、执行启动、
模型继续请求和完成时间。继续请求必须保留原始消息、assistant 工具调用 ID 和
匹配的成功工具结果。断言仅一个 prompt，工具 Turn 恰好两次模型请求，以及一次
实际 Workspace 写入。模型流耗时独立记录，不以总耗时减去 Runtime 等待推算。
记录每个 Turn 的存储 HTTP 请求数，使持久化开销可见；历史增长和缓存选型另行处理。

## 基线与 CI

提交实际本地采集的基线，附基础 Git commit、工作区修改状态、夹具源码哈希、
采集时间、平台、Node 和数据库版本、测量定义与范围说明。每次运行读取该产物，
比较完整场景集合、测量版本、延迟及顺序约束。缺失、重复或无效测量必须失败。
绝对毫秒差异仅报告，不作为共享 runner 的性能阈值。

固定本地 provider 使其成为无条件运行的顺序验收测试；时间代表基础设施测量，
不代表真实模型延迟。本次不新增依赖凭据的探测，不修改普通 daemon 基线。
未来真实 provider 探测必须复用 `shouldSkipPromptLatency()`。

复用 `HostedWorkspaceToolTurnIT` 夹具和 Maven profile。运行报告保存到
`target/hosted-latency-baseline.json`；Hosted MySQL CI 上传报告，缺失时失败。
工作流路径过滤加入 Hosted helper 和基线，确保仅修改驱动时也运行检查。

## 影响文件与验证

- `integration-tests/` 下新增延迟驱动、测量校验器、聚焦测试和入库基线。
- 扩展 `HostedWorkspaceToolTurnIT`，调用驱动并检查 SQL 结果。
- 更新 `.github/workflows/sdk-java.yml`，触发并保留测量。

构建、类型检查并打包仓库。运行校验器聚焦测试、现有 Workspace 工具测试和
新的 Spring + SQL 延迟测试。在现有 MySQL CI profile 中运行同一测试。
负向校验测试必须拒绝场景缺失、顺序颠倒、时间缺失或非有限数值，以及无效
上下文继续证据。入库前将产物与原始运行结果核对。

## 验收标准与待定问题

两个场景均在 Runtime 就绪前产生模型文本。无工具 Turn 在就绪前完成，且不获取
工具会话。工具请求先于就绪，等待后只执行一次写入，在同一模型上下文中继续，
最终成功完成。报告包含真实测量，测试读取入库基线。本夹具范围内没有未决设计
问题；真实 provider 和公开入口延迟属于独立探测。

## 复现与刷新

使用 Node 22+、Java 21 和 Maven，并按现有 Hosted 夹具要求将 Java SDK 和
Runtime Broker 安装到本地。从仓库根目录运行：

```bash
npm run build && npm run bundle
mvn -f packages/sdk-java/managed-agent-server/pom.xml -Phosted-workspace-tools \
  '-Dit.test=HostedWorkspaceToolTurnIT#recordsLatencyWithDelayedRuntimeProvisioning' \
  -Dnode.executable="$(command -v node)" verify checkstyle:check
```

默认使用 H2，与
[`hosted-latency.json`](../../integration-tests/baselines/hosted-latency.json)
比较。传入 `-Dmysql.url`、`-Dmysql.user` 和 `-Dmysql.password` 可改用独立的
MySQL 兼容数据库；报告记录其实际版本。仅在有意刷新入库基线时，为同一命令
设置 `QWEN_HOSTED_UPDATE_BASELINE=1`。随后不带此变量再次运行，验证比较逻辑，
检查报告和 Git diff，将产物与夹具修改一起提交。不同数据库引擎和机器会在
产物中标明，绝对耗时差异仅供参考。
