# Turn 提交前串行准备 Runtime

[English](2026-11-16-managed-workspace-provisioning-retry.md) | [简体中文](2026-11-16-managed-workspace-provisioning-retry.zh-CN.md)

状态：已实现；本地构建、定向回归和选定的真实进程 MySQL 检查通过。完整 CI 和已部署 provider 验收仍待完成。对应 [#17380](https://github.com/QwenLM/qwen-code/issues/17380)。

## 问题

协调器原先启动 Runtime warm-up 后，立即打开 Harness Session。仍在准备的 Workspace 可能拒绝 load，并耗尽五次 admission 重试；默认退避仅合计 31 秒。扩展预算豁免需要把 daemon 拒绝码和 Broker 状态关联，还要维护额外的等待上限。

改为在未提交的 Workspace Turn 加载 Harness Session 前准备 Runtime。准备成为明确的执行步骤，无需再根据 load 失败推断准备状态。

## 执行顺序

1. 保留可选的 Session 创建时异步预热，让准备工作可以提前开始。
2. 未提交且不在取消中的 Workspace Turn 加载 Harness 前，启动或加入 Broker 已有的 warm 操作，并等待完成。
3. 等待 warm 及其 `environment.ready` 事件发布完成后，加载 Harness Session。load 仍会检查 daemon Workspace 是否 active；Broker warm 完成本身不证明 daemon 已激活。
4. 通过现有 admission 和 journal fencing 提交原 Turn。

生产派发器已经使用虚拟线程。有时限的 future 等待不会占用固定的派发工作线程池，现有独立调度器继续为 Turn 续租。

## 准备策略

复用 `qwen.managed-agent.harness.load-timeout` 作为准备等待上限，当前默认 120 秒。校验其为正数；不新增配置、schema、readiness 缓存或 Workspace 专用重试预算。等待使用单调时钟，不修改或取消 Broker 共享的 future。

future 等待和重试退避均切成不超过一秒的间隔，让循环能够检查最新持久化 Turn 和派发租约。同时核对续租信号、记录中的 owner 和租约到期时间。未提交的取消通过已有 fenced 取消写入落定。Turn 不存在或已终态时停止当前派发。warm 完成后，在 load 前再次检查取消和租约所有权；开始下一次 warm 前也执行这些检查。迟到的 warm 回调只发送 environment 事件，不会恢复已取消的 Turn。

准备尚未完成时不调用 Harness load，也不增加执行重试计数。可重试的 `RuntimeBrokerException` 在同一等待上限内重试准备，沿用现有初始重试间隔，不按 wire code 分类。不可重试的 Broker 失败保留自己的 code 和 message。未知 warm 失败映射为 `runtime_warm_failed`；等待超时以 `runtime_preparation_timeout` 终止。线程中断时恢复中断标记，并回到现有派发失败处理。

该上限约束单次取得派发租约后的准备尝试。进程重启后，新 owner 重新询问 Broker，并依赖原 binding、operation 所有权和 Broker provisioning 截止时间的持久化状态。不新增持久化准备计时器，也不声称协调器的墙上时钟截止时间跨重启保持不变。

## 兼容性与范围

未启用 warm 时跳过准备。未绑定 Workspace 的纯文本 Turn 保持可选的异步 warm：启用 Broker 不代表文本响应必须依赖 worker。已经提交的 Turn 保持现有异步 warm 和恢复行为；取消中的 Turn 完全绕过新增准备步骤。

准备成功后的 load 拒绝继续走普通重试策略。具名 503 `workspace_runtime_unavailable` 原本就保留自己的 code；同时让旧 409 `workspace_unavailable` 在耗尽预算时保留自己的 code。因此永久 blocked 的 daemon Workspace 仍会终止。不扩展 pool/ownership 豁免、generation churn 上限或提交后重试。

不修改 daemon 路由、租户检查、Workspace 授权、storage claim、API schema 或数据库操作。明确的代价是：未提交的 Workspace Turn 会等待已启用的 Runtime 准备，即使最终响应不使用工具。

## 验证与验收

定向回归应覆盖准备完成后才 load、pending 时不计重试、ready 后只提交一次、永不完成的 warm 有界退出、可重试准备失败的恢复、明确的永久错误、等待期间取消及迟到完成、重试退避期间取消且不重新 warm、租约丢失、未启用 warm、未绑定 Workspace 的纯文本及已提交 Turn 的兼容性，以及 ready 后新旧 load 拒绝。

macOS 本地验证通过 JDK 21 编译、Checkstyle、全部 20 个新增准备流程用例和全部 152 个已有 coordinator 用例。当前 checkout 也通过 `npm run build`、`npm run typecheck`、`npm run bundle`、83 个 E2E runner 回归测试、ESLint 和格式检查。

两个选定的 Hosted 用例在 macOS 上使用独立 MySQL 8.4.11、生产 Broker、真实 daemon、原生 worker 和已注册的原生 storage，通过回环地址的受控模型完成验证。用例阻塞 worker 启动两秒，同时将普通 admission 退避压缩至 30 毫秒。准备期间不得 load、submit 或增加重试计数；释放 worker 后，原 Turn 必须只提交一次，并完成三个文件工具。每次模型 HTTP 请求都必须观察到已提交的 `environment.ready`。取消后，即使 worker 和迟到的就绪事件到达，Turn 仍须保持终态，且不执行模型或工具。

这些结果证明选定的本地链路，不等于云上 45 秒准备或真实上游模型验证。准备期间进程重启、完整 unit/SpotBugs/MySQL/Hosted/fault profiles、Linux 资格验证及已部署 provider 验收，仍待各自 CI 或环境检查。
