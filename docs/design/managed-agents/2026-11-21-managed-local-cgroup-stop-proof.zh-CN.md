# 本地 Runtime 的持久 cgroup 身份与停止证明

[English](2026-11-21-managed-local-cgroup-stop-proof.md) | [简体中文](2026-11-21-managed-local-cgroup-stop-proof.zh-CN.md)

## 问题与范围

[#14667](https://github.com/QwenLM/qwen-code/issues/14667) 要求约束进程树，并在 Hosted Runtime worker 死亡后仍能验证停止。stdio MCP supervisor 回收的是进程组，创建新 session 的后代会离开该组。持久 local provisioner 检查原 worker 的 PID 和启动身份，但普通的 stopped-worker 回执没有证明后代已经退出。扩展专用的停止协议依赖仍存活的 worker 和独立的 cgroup 层级。

这是 [#15081](https://github.com/QwenLM/qwen-code/issues/15081) 的一个阶段，为 Session 独占的 Linux 持久 `local-process` Managed Workspace 绑定增加停止证据。覆盖 worker 和继承其 cgroup 的后代，包括 stdio MCP 和脱离原进程组的后代。由 Broker 取得证明，供现有 drain 与恢复链路使用。独立阶段处理私有文件系统启用、默认启用、共享 Runtime 绑定、由外部服务启动的子进程、MCP supervisor 内存和 Windows 支持。

## 启用与信任边界

运维将 `qwen.managed-agent.runtime-broker.provider-options.cgroup-root` 设为 cgroup v2 上专用、规范化且已委派的目录。local provider 只在持久 Linux 模式下接受该设置。新建的 Managed 绑定需有关联 storage，满足 `WorkspaceExecutionProfile.admitsIsolationClass` 与 `admitsCapabilityDigest`，并排除 Managed 扩展执行档案。非 Managed worker 沿用现有路径。对不支持的 Managed 放置在分配或启动 worker 前拒绝。已有版本 2 的登记使用其记录的档案；版本 3 的绑定即使遇到配置变更，也使用原单元。

Broker 和 worker 是受信服务进程。部署端控制状态目录、cgroup 层级和挂载 namespace。部署必须阻止工具、同 UID 的不可信宿主进程及其他管理者把 Runtime 进程移出绑定单元、将其他进程移入该单元或修改恢复记录。委派根及其上级路径须保持稳定，只有 Broker 能在资源锁下创建或删除其单元。运维须避免其他挂载覆盖这些路径。从版本 3 worker 的启动环境移除 `QWEN_MANAGED_HOOK_CGROUP_ROOT`。前台工具与 stdio MCP 继承原单元。依赖独立委派 supervisor 的命令型 Hook、后台 Shell 和 Monitor 继续使用已有的隔离不可用拒绝。未来面向不可信用户的 Hosted 档案须将此 cgroup 控制面与 payload 隔离。

## 资源身份与启动顺序

现有 provision request 锁串行化分配、启动、恢复和停止。为新建且符合要求的 intent 在委派根下创建 leaf，名称由 provision request 摘要导出。同名目录已存在时拒绝。检查 cgroup v2 类型、domain 模式、`cgroup.procs` 和 `cgroup.events` 可读，以及 `cgroup.procs` 和 `cgroup.kill` 可写。

使用版本 3 的本地资源句柄。保留现有宿主、boot、PID/time namespace 和请求身份，关联 provision request、Runtime 实例、lease epoch 及 Workspace 代次。加入规范化的委派根、cgroup namespace 以及根目录和 leaf 的内核文件系统对象身份。先将同一份句柄写入经 fsync 的本地登记，再返回给 Broker 持久化。重试复用已记录的句柄。新版登记编码为版本 2，要求版本 3 句柄。版本 2 句柄继续使用版本 1 登记编码。拒绝混用。登记同步前遗留的目录由运维检查，不按名称接管。状态缺失或冲突时保留原绑定围栏。

provisioner 记录 `LAUNCHING`，检查准确的单元，再按字面 argv 启动固定的本地 shell trampoline。它将自己的 PID 加入单元，并通过 Broker 的 stdin 管道等候启动行。Broker 在同一资源锁下重开原单元并核验身份，观察该存活 PID 已加入，持久化 `REGISTERED`，然后先通过 stdin 发送启动行，再发送现有启动信封。trampoline 收到启动行后才 exec 配置好的 worker。EOF、迁移失败或归属不符均不能授权 exec。若崩溃留下 `LAUNCHING`，继续阻止恢复，因为尚未登记的 trampoline 仍有可能正进入单元。接管就绪 worker 时重新检查单元与存活 worker 的归属。已登记或退休的身份不启动新的 worker。

## 停止与恢复

现有 Broker drain 先封住新执行并保留绑定的操作权限，再调用 provider。版本 3 的整绑定终止 drain（包括资源 drain 和存储退休）对 Broker 开始 drain 时仍持有的 member 使用现有的证明优先分支。要求工作已结算，在释放 Session 或 member 前持久化停止回执。尚无回执的 stopped-only 路径仍要求匹配的 worker 缺失证据。在内核 I/O 前重新验证 drain claim 和相关生命周期权限。过期 claim 无法提交回执或清除 member。迟到的停止可留下以后能复用的本地停止事实。版本 3 由 provider 持有原登记的锁，重新打开记录的准确单元。核验目录描述符绑定的身份，通过相对路径以 no-follow 打开文件。kill 文件以写方式打开，禁止创建或截断，从而防止同名替代单元接收 kill 或提供证据。核对登记身份后，若单元中还有进程，向 `cgroup.kill` 写入 `1`，在时限内等待内核在 `cgroup.events` 中给出递归的 `populated 0`。确认原 worker 已退出。写入成功或 PID 不存在均无法单独证明停止。尚无证明时，单元不可读、被替换、缺失或仍有进程均保留 storage holder，并返回停止未确认。观察可独立证明 journal 丢失。worker 已不在且原单元已经为空时，观察可持久化停止事实并返回两份证据，不发送信号。单元仍 populated 或无法验证时不给出 writer 停止证据。

只有验证单元为空且 worker 已退出，或满足现有可信整机重启证明，才在登记锁下持久化 `RETIRED`。版本 3 的这一状态是原单元停止的持久证据。持久化后尽可能删除已验证为空的 leaf。删除后的重试使用已保存的证明。确认可信重启后，不能打开或操作新 boot 下的同名单元。同一 boot 下缺少已保存的证明时，离线运维需核验同一个原单元，且要求它已经为空。观察、接管及无效 ready 信封的清理都须具备已验证的证据才能写入版本 3 的 `RETIRED`。重开的退休状态可为现有 LOST 对账规则提供停止证据。已经进入 LOST 的绑定继续使用该恢复路径和其执行结算规则。单元仍有进程时，隔离的运维恢复须先停止原单元再做证明。通过已验证 LOST 恢复进入 RELEASED 的版本 3 绑定，可用精确的停止与丢失证据满足后续资源 drain 重试。即使当前配置缺失，维护路径仍使用已保存的句柄。

复用已有 Broker 回执、代次校验、回执持久化与受围栏约束的 Session/member 释放事务。版本 3 的退休 transport 尾部只核实已无 member。更早的 Harness 活进程 detach 请求、普通回合 handback 和停放沿用可信部署的活 owner 规则。这些成功确认独立于此 worker 退休证明。回执携带原 provision request 的精确持久句柄。如果 SQL 尚无句柄且 worker 从未获准启动，则使用锁内原 intent。启动和停止复用公开 API 与 TypeScript 启动信封。canonical V1 catalog 将本地版本 3 绑定纳入索引中的恢复候选。按现有 V1 策略初始化新的开发 catalog。内核确认单元为空只能证明停止。journal 丢失、工具结果未知与重放继续遵循现有门禁。

## 验收

使用专用测试 cgroup，运行真实 Linux provisioner 和 Broker drain。验证 worker 与测试自行启动、创建独立 session 的后代在执行前已加入单元，随后强制杀死 worker，并确认后代仍存活且单元仍 populated。在新 provisioner 中重开原登记。验证 PID 消失本身不给出停止证明、把另一个活动 cgroup 绑定挂载到原单元路径后，不能生成回执或触发释放，两个单元都不被终止，原单元被终止并证空后才记录回执与释放原 holder。验证存活 worker 的终止 drain 在 handback 前经过同一证明门禁、单元删除后幂等重试、同级对照进程继续存活、实际加入失败或 gate EOF 时 worker 没有副作用，以及旧持久登记兼容性。使用真实 Linux provisioner、Broker 和 Workspace transport。在隔离 MySQL catalog 中检查原 Session 的 execution storage key 和物理 member 数。运行已有的延迟停止结果 claim 围栏回归，记录环境限制。
