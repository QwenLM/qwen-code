# 本地 Runtime 持久接管（W0e-2）

[English](2026-09-27-local-runtime-adoption.md) | [简体中文](2026-09-27-local-runtime-adoption.zh-CN.md)

状态：实施设计。基于 [W0e-1](2026-09-27-managed-workspace-recovery.zh-CN.md)。

## 问题与范围

本地 provisioner 只认识当前 JVM 启动的进程。Broker 重启后不能接管存活 worker，重试中断的启动还可能生成凭据相同的第二个进程。受支持部署限定为 Linux 单机、管理员管理的本地持久存储和可信 worker。此方案不隔离恶意同 UID 工具，不覆盖远程存储，也不覆盖重启后重新创建写入者的外部任务。

## 持久身份与启动顺序

`runtime-broker.durable-local-process`（默认开启）使用配置的状态目录，且目录必须在 Workspace 根目录之外。Linux `/etc/machine-id` 和 `/proc/sys/kernel/random/boot_id` 提供 host 与 boot 身份。检查进程前还必须匹配 `/proc/self/ns/pid` 保存的 PID namespace 和 `/proc/self/ns/time` 保存的 time namespace，因为 [Linux PID 仅在本 namespace 有效](https://docs.kernel.org/admin-guide/namespaces/compatibility-list.html)。要求内核暴露这两种 namespace 身份；不支持或无法读取时启动失败。测试通过包内构造器注入身份；部署配置不接受调用方提供的 boot 证据。

machine ID 必须非空且稳定。服务管理器必须允许 Broker 退出后 worker 继续存活；默认 systemd `KillMode=control-group` 单元或以 Broker 为主进程的容器也会杀死 worker。配置服务保留子进程（例如 systemd `KillMode=process`），并使用会回收孤儿进程的 init，避免积累僵尸进程。

每个 provision seed 对应一个 SHA-256 资源键、永久锁文件和版本化 JSON 记录。目录仅属主可访问，文件仅属主可读写；符号链接、异常属主或权限、记录缺失与损坏均保持阻断。原子文件替换及文件、目录 sync 发布每次状态。token 仍只保留于现有 SQL 加密 seed。记录将非秘密 seed 身份和完整 placement 摘要绑定到 host/boot；v2 handle 不含凭据或物理路径。

每个 seed 的 OS 文件锁串行化跨 Broker 的启动与观察。启动者先持久化 `INTENT`，在 spawn 前持久化 `LAUNCHING`，并在发送第一个 boot 字节前以 `REGISTERED` 持久化实际 PID 与 `/proc/<pid>/stat` 第 22 字段的原始启动 tick。可信直接 worker 命令在 stdin EOF 后解析完整 boot 文档，随后才开放监听。中断的 `LAUNCHING` 记录不能再次启动；`REGISTERED` worker 可被观察并恢复 ready 输出。ready 输出写入私有文件，避免依赖 Broker 生存期的 stdout 管道。验证 ready 和完整 attestation 后，先持久化 `READY` 与 endpoint，再返回 lease。发布中断时可从原登记进程和有界 ready 记录恢复，不能创建替代进程。

## 接管与生命周期

同 seed 重试收敛到已有记录。接管必须匹配 host、boot、精确 PID/启动 tick、seed、placement、loopback endpoint，并通过完整 transport attestation。缺失内核启动信息不算匹配。锁忙时返回不确定。普通 v1 handle 在重启后继续阻断。managed boot v2 与 legacy boot v1 共用启动协议。

启动 tick 只在已保存的 boot、PID/time namespace 内比较。Linux 不以 Java 墙钟 `startInstant` 证明死亡，因为校时会改变其使用的 boot epoch。解析时跳过完整括号内的命令名，其中允许空格、括号和换行；读取失败不构成证据。Linux 区分 stat 文件不存在与其他读取错误；后者不能退休 journal 或使缓存 worker 失效。部署必须保持 Broker 用户及其 procfs 可见性稳定。临时 worker 保留原 `Process` 基于 reaper 的存活判断。可移植测试使用的非 Linux 身份不能部署。

匹配原启动 tick 后，任务状态为 `Z` 或 `X` 表示 worker 已退出；这仍不能证明逃逸写入者已停止。

只有 provisioner 明确支持已存 handle 时，Broker 才能恢复中断的 provisioning。被阻断的启动可以被观察，但观察不能 spawn。现有 SQL operation claim 隔离迟到回调，Session、grant、activation 和 storage lease 校验均继续生效。执行控制沿用[现有取消与对账契约](managed-runtime-broker-service-core.zh-CN.md)：过期 dispatch 使用原 key 隔离，再从原 worker 对账结果；单独 GET 不推进状态。已经处于 `UNKNOWN` 的调用仍不在物理取消契约范围内；此功能不代表 Hosted Turn 接管或重放。

未发布 lease 的 `INTENT` 或 `LAUNCHING` 记录，以及 lease 发布前已退休的进程，返回不可重试的资源冲突，不再反复对账超时。没有工具派发能抵达该 worker。原 placement 继续封闭；观察不会启动替代进程，也不编造丢失或写入者停止证据。文件锁忙或进程身份不可读仍为不确定。

关闭 durable provisioner 仅分离观察者。丢失 SQL claim 后丢弃 lease 也仅分离，因为另一 Broker 可能已接管同一 worker。两者均不杀进程、不删除记录。临时模式构造器保留原关闭语义。精确进程死亡可记录 journal 丢失和禁止重启的持久墓碑，但不提供写入者停止证明。物理复用继续阻断，包括逃逸子孙进程。W0e-3 只增加显式可信同宿主重启证明及精确 storage holder 清理，不引入通用强制解锁或按 PID 杀进程恢复。

## 影响组件与兼容性

`LocalProcessRuntimeProvisioner` 的临时与持久模式共用 boot/ready 解析。包内本地 store 负责锁和持久记录。`RuntimeProvisioner` 及 Workspace wrapper 提供范围明确的启动恢复支持；`RuntimeBrokerService` 允许观察受支持的已保存启动记录。嵌入配置默认启用该模式（同时设置 `runtime-broker.durable-local-process=false` 与 `runtime-broker.trusted-local-reboot-recovery=false` 可退出；打包服务把这两个开关分别映射为 `QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS` 与 `QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY`），并拒绝落在任何配置 Workspace 根目录下的恢复目录。无需数据库迁移或公共 API 变更。现有构造器保持临时模式，默认配置使用持久模式。

## 验证与验收

真实 Broker 进程在 SIGKILL 后必须接管原真实 worker，身份、token、endpoint 与执行回执均不改变。覆盖两种 boot、启动中断（包括未 fork 的失败）、并发 Broker、迟到 lease 丢弃、共享观察者关闭、placement 不匹配、记录缺失或损坏、不安全权限、符号链接、PID 复用、僵尸状态和缺失启动身份。负向案例不能启动第二个 worker 或清除物理 pin。继续执行 Stage F、HTTP、Java SQL 和 CLI 回归，以及 build/typecheck 和两轮干净全量 diff 审计。模拟 boot 身份仅验证决策；真实 Linux 重启验收属于 W0e-3，必须使用专用宿主。

## 待验证事项

本地开发宿主为 macOS。可移植真实进程测试使用仅测试可用的身份源。[PR #12865](https://github.com/QwenLM/qwen-code/pull/12865) 记录了独立的生产 Linux 接管验证；物理重启验收门属于 W0e-3。
