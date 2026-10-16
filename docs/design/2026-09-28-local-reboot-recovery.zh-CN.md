# 可信本地重启恢复（W0e-3）

[English](2026-09-28-local-reboot-recovery.md) | [简体中文](2026-09-28-local-reboot-recovery.zh-CN.md)

状态：实施设计，接续[持久接管](2026-09-27-local-runtime-adoption.zh-CN.md)。

## 问题与范围

Runtime journal 丢失可以结束未知执行，却不能证明写入者已停止。Workspace storage 必须保留占用，直到物理证据和精确 holder 清理均完成。actor 被撤权或产品 Session 删除后，恢复也必须能推进；现有先授权的 warm/acquire 路径不能提供独立维护入口。

本切片仅支持可信工作负载、Linux 单宿主及管理员管理的本地持久存储。不隔离恶意同 UID 工具、远程写入者、重新创建写入者的外部任务或快照恢复/克隆。machine 身份、本地记录、SQL 密钥和存储归属必须稳定。仅 worker 死亡始终不够，即使当前看不到进程。

## 可信重启证明

默认开启。启用可信本地重启恢复必须同时启用本地持久 provisioning。生产读取 machine ID 和内核 boot ID；在上述本地存储契约内，同一保存宿主的 boot 改变证明原 boot 写入者不再存活。systemd soft reboot 不改变内核 boot ID，不能充当停止证据。原登记必须仍能验证完整 provision seed、placement 和保存 handle；缺失、损坏或旧格式记录不能重建。同 boot 的 PID/time namespace 变化仍是不确定状态。

产生证据前，provisioner 在永久 per-seed 锁内原子写入原记录墓碑，然后对同一原 host/boot/resource 域返回 JOURNAL_LOST 和 WRITERS_STOPPED。此前进程死亡的 loss 证据保持不变，后来的重启证据只解除物理不确定性。启动中断时，已保存 seed 和 handle 足够核验，无需编造缺失 endpoint 或 lease。观察永不重新启动原 seed。

## 有序清理

Broker 先持久化 loss 证据，每次事务最多放弃 100 个非终态执行。SETTLED 保留结果，但成功回执不能证明工具写入的文件在断电前已 fsync。ABANDONED 始终表示终态不确定性，不能重放。只有 loss 的清理保留全部物理占用。

全部执行进入终态且 stop 证据持久化后，由可信 provisioner 回调清理原保存 Binding。Workspace wrapper 仅用原 tenant、storage ID、Binding ID、generation 和 holder 身份清理 SQL storage holder，不读取当前 actor grant、产品 Session 状态、Registry、mounts、文件系统或 worker HTTP。

清理事务锁定并验证保存 Binding 与未过期 operation claim，再锁原 holder。只条件清除精确匹配的原 holder；holder 已不存在或属于其他代数时已完成，不能删除其他占用者。清理后崩溃可安全重试。回调完成后，最终有界事务才释放 Runtime Sessions、退休 Binding 和清除 placement slot。回调失败、claim 过期或批处理未完时保留剩余占用。

迟到 acquire 必须依次锁 Binding、Runtime Session、holder，复查 READY、未 draining 和原 Session 归属，不能在 loss 屏障后重新建立旧 holder。managed LOST 代数不能通过普通 release 绕过清理。

## 恢复入口与调度

可信进程内入口 `recoverBinding(bindingId, expectedGeneration)` 读取原保存记录，与交互操作共享 per-binding 排他和 SQL operation claim，执行有界观察与清理，返回原代数状态。不调用当前 Session resolver，不构造新 placement，不 ensure 新资源，不启动进程或创建替代代数。

Spring 仅在启用可信本地恢复时调度有界扫描。轮转的 Binding ID 游标避免长期不确定记录使后续候选饥饿。批次不重叠，每次观察有截止时间。恢复不依赖活跃 Hosted Turn 或当前用户授权。允许接管存活 worker，但不能发起新执行。物理清理完成后，后续通过当前授权的 warm 才能创建下一代。不增加 HTTP 路由或强制解锁 API。

## 组件与兼容性

本地 store/provisioner 增加显式 reboot policy 和无 lease 的 seed 证据匹配。Binding 仓库增加有界候选查询与独立最终释放步骤。Workspace execution store 增加 acquire 屏障及精确失联 holder 清理。嵌入配置连接 policy、wrapper 回调和后台 coordinator。复用已有 SQL 表和证据字段，无需迁移。临时行为仍可在同时关闭 durable-local-process 与可信重启恢复时获得；持久存活 worker 接管保持不变。公开 `workspace_context` 能力仍为 false。

## 验证与验收

覆盖两种 boot 协议、无 lease 的登记中断、同宿主 boot 改变、错误宿主、缺失/损坏记录、同 boot 的 PID/time namespace 改变、worker 死亡但逃逸子进程存活、超过 100 个执行、清理 holder 后崩溃、过期 claim 与迟到 acquire、新 holder 不被旧清理删除。真实 SQL 链路必须证明撤权、删除产品 Session、修改 Registry/mount 后仍按原保存 Workspace 恢复，且维护过程不能接受新的未授权执行或启动替代 Runtime。

执行 Java HTTP/H2、现有 MySQL 集成通道、真实 worker Stage F、build/typecheck、格式检查和连续两轮干净全量 diff 审计。模拟 boot 身份只能证明决策。物理验收需要专用受支持 Linux 主机：记录原 worker 与逃逸写入者，保留本地磁盘和 SQL 进行重启，以相同配置恢复服务，再核对旧回执、holder 退休和新授权代数。不能重启共享开发机充当验收。

## 验收证据与边界

独立评审者已在专用 Debian 12 Linux 虚拟机上对 W0e-3 head `8c2b626c` 完成物理门禁，包括真实重启、断电对照、逃逸写入者、holder 清理和回执保留（[第三轮报告](https://github.com/QwenLM/qwen-code/pull/12869#issuecomment-5877187325)）。可移植 macOS 测试和模拟 boot 变化是独立证据。之后的改动仍需对应 head 的验证；此前的物理实测不能证明每个后续补丁也经历了重启测试。

`durable-local-process` 与 `trusted-local-reboot-recovery` 的默认开启仅以可移植（合成身份）证据发布：按上述规则，翻转 head 的精确物理验收作为后续项欠付，本次翻默认不放低该门槛。
