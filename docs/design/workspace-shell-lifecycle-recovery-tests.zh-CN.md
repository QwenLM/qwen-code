# Shell 生命周期恢复验收

[English](workspace-shell-lifecycle-recovery-tests.md) | [简体中文](workspace-shell-lifecycle-recovery-tests.zh-CN.md)

## 当前状态与范围

PR #13931 为精确 `hosted-workspace-shell/1` 和 `hosted-workspace-mcp/1`
实现了 lifecycle v2。已有真实 MySQL writer/claim 测试和通用 POSIX 进程测试，
尚未覆盖驻留 Harness 经生产 Spring HTTP 生命周期操作的完整链路。
V2 能力声明仍默认关闭。

第一片验收覆盖前台 Turn 已结束后的公开 Shell 删除、驻留 writer 租约过期、
Spring owner 被杀，以及资源或 detach 回复丢失。使用真实 MySQL、CLI 构建产物、
原 Linux 持久 worker 和生产生命周期/退役/回收实现。除测试装置外，还修复
detach 回复丢失后缓存 Harness 引用已不存在时的恢复问题。

真实 HTTP 基线已复现：detach 成功但回复丢失，Harness 删除驻留 Session，
Java 仍缓存引用；随后资源请求反复返回 404，却不重新加载清理会话。
修复仅在 v2 资源阶段收到明确 404 时移除对应旧引用，并继续抛出原错误。
下一次有效 claim 从保存的 definition 和原 Runtime 身份恢复清理。
未知回复或引用不存在都不能证明完成；effects、files v1 和其他错误保持原语义。

当前公开 definition 不包含 `hookCatalog` 或 `mcpServers`，因此 Java 会直接保存
空 effects，不调用 Harness effects 阶段。这些测试不能认证 Hook 执行与幂等、
MCP 释放、后台 Shell 或 Monitor 停止，也不会向生产请求注入这些字段。
完整 L4/H3/reboot/publication 矩阵仍是独立发布门槛。

## 装置与边界

`HostedShellLifecycleRecoveryIT` 持有模型装置、CLI 构建的 Harness，以及三个地址
稳定的 loopback HTTP relay。仅用于测试的 `HostedShellLifecycleFixtureMain`
根据显式配置文件启动独立的生产 Spring 进程。第二个 Spring 启动时保留同一
MySQL 数据库、挂载、凭据和原持久 worker 目录。Relay 只切换后端地址，
不改写 Session definition 或 Runtime 身份。

本地模型只产生一个前台 Shell 命令和一个最终回复。通过公开审批接口回答真实
待处理 action。共享目录 marker 和已捕获 stdout 证明生命周期准入前命令只执行
一次。模型在 Spring 之外保持可用，杀掉 Spring 不会替换模型或 Harness。

Relay 保留端到端 header/body，移除 HTTP hop header，只转发到选定的一个后端。
故障仅发生在明确的 HTTP 边界：`prepare_resources` 转发前，
`settle_resources` 成功后，或 detach 成功后。不会用 SQL 改变租约、claim、
输出证据、退役或回收状态。SQL 读取观察持久台账；registry/access 插入仅初始化
装置授权和挂载。

## 用例与验收证据

| 用例              | 切断点                                                                     | 必需证据                                                                                         |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 驻留租约过期      | 阻塞第一次 prepare 请求，直到 MySQL 确认原 writer 租约已过期               | 当前 v2 DRAINING claim 在 detach 前续租同一 writer ID/token/generation；命令一次、Runtime 原身份 |
| Spring owner 死亡 | 第一次 prepare 转发前杀掉 Spring，等待 claim/writer 自然到期，再切第二进程 | 切断时原 worker 仍存活；新 claim generation；旧请求重放被拒绝；保留原身份                        |
| 资源 ACK 丢失     | 转发成功的 `settle_resources`，随后关闭回复连接                            | 重试完成，不重跑命令、不替换 worker、不补造资源证据                                              |
| Detach ACK 丢失   | 转发成功的 detach，随后关闭回复连接                                        | 明确资源 404 清除旧引用；下一 claim 在原 writer 封口后获取清理 writer，并安全完成                |

每个用例经公开 REST 或 WebShell 发起 delete，等待公开 operation 结果，
检查 protocol 2、删除 tombstone、私有输出退役和定时 O4 回收。捕获的字节变为
不可访问/被清空，同时保留 companion Session 和共享 Workspace marker。
记录确切进程 PID、原 binding/generation、writer 身份、claim generation 和
注入边界；未到达切断点或恢复未完成都必须使测试失败。

在转发前观察 writer 自然到期，不依赖任意 sleep 推断。丢弃 ACK 前必须先观察
阶段成功。旧请求在新 claim 持有资源边界时重放，不能等 Session 删除隐藏身份后
才验证。Timeout 仅限定失败等待，不替代这些同步条件。

驻留恢复保留原 writer ID、token 和 generation。确认 detach 已封口后，冷恢复
可以获取 generation 递增的清理 writer，旧 writer 仍被围栏拒绝。该用例独立核对
原 Runtime 身份以及已封口 manifest 的摘要和长度，禁止借新清理 writer 替换
执行或 capture。Connector 单测与真实 MySQL 测试覆盖精确 Shell/MCP profile，
以及普通请求、旧 claim 获取清理 writer 被拒绝的边界。

## 执行与剩余门槛

完整测试要求 Linux 和真实 MySQL，生产持久 worker 使用 Linux boot/process/
namespace 身份。加入已有 `hosted-harness-mysql` Maven profile 和 Hosted CI；
报告检查器要求新增 Hosted 测试类实际运行。不绕过 OS 条件，不 mock provisioner
或 stop proof。macOS 编译、relay 单测及跳过的集成用例与 Linux 执行分开报告。

发布前仍需独立补齐生命周期 Hook 切断点、其余 effects/seal/stop/tombstone
阶段故障、后台 Shell/Monitor H3 与 reboot 身份、live MCP transport 和 O2
对象 publication。全部 Java/Broker 消费者先升级，再启用已验收 Shell v2，MCP
单独验收。存在未完成 v2 操作时仍禁止回滚到 v1-only 消费者。
本 PR 不启用 profile、不部署、不合并。

## 未决问题

此片测试范围没有未决问题。实际结果与确切提交归属记录在 E2E 报告中，
不能由设计文档推定已通过。
