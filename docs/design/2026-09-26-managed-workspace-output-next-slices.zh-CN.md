# Managed Workspace：Broker Context 集成（W0c-2）

[English](2026-09-26-managed-workspace-output-next-slices.md) | [简体中文](2026-09-26-managed-workspace-output-next-slices.zh-CN.md)

状态：在 draft PR #12730 中实现。基线：2026-09-26 的 `main`，提交 `342ba1bcd`。本改动完成 [W0c #12724](https://github.com/QwenLM/qwen-code/issues/12724) 的 Broker 切片，属于 [proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380)。

## 1. 当前状态与范围

W0b #12709 与 W0c-1 #12732 已合入。Worker 接收 boot v2、输出 ready v2、提供 attestation/context v3，并将 tool v2 执行固定到已安装的 Session 目录。Java 仍写入 boot v1、使用 attestation v2。ready 之前发生暂时失败时，下次 warm 可能再次启动进程。

本切片增加 Broker 显式启用方式、持久化 storage 身份、严格的 v2/v3 协议准入、context installation 客户端及持久化的单次启动限制。它不放行绑定 Workspace 的 Session；EmbeddedRuntimeBroker 的产品门禁继续关闭，等待 W0c-3。

## 2. Provision 身份与持久化

`RuntimeScope` 保留六个字段以及已有 Session/execution scope hash。不可变 `RuntimeProvisionRequest` 上显式传入的 `storageId` 选择 managed-context/1；旧构造器保留 boot v1。mount root 使用 scope 的 `canonicalCwd`，不能是 Session 子目录。已有 Broker 持久化将该字符串限制在 512 个 UTF-16 单元内，也在 envelope 的 4096 字节限制内；继续明确保留这个更严格的本地限制。

`RuntimeProvisioner.createRequest` 生成请求。LocalProcess 可接收管理员提供的 storage resolver；启用后每个 scope 都必须返回非空且合法的 storage ID。不能从调用者路径或推导的 Workspace ID 建立 storage 授权。W0c-3 在检查 Registry、generation 和授权后提供产品 resolver。

binding slot 和 binding 都持久化可空 `storage_id`。managed-context request hash 使用独立域并纳入该字段；legacy 行的 request hash 逐字节保持原样，scope hash 不变。confirm、reconcile 和 recovery 从已持久化请求恢复协议选择，不能从当前 resolver 默认值重新推导。JDBC schema 初始化以增量方式升级已有表；server Flyway 新增迁移，不修改已发布迁移。

旧 Broker 二进制不能安全解释 managed-context 行。启用 resolver 前需升级所有 Broker reader；回滚旧版本前必须排空 managed-context binding。新版本继续读取已有 legacy 行。测试固定 legacy hash，并拒绝被篡改的 storage 身份。

## 3. 协议准入与安装

使用封闭的 [managed-context envelope](2026-09-25-managed-context-envelope.zh-CN.md) 及 [Worker 行为](2026-09-26-managed-context-worker.zh-CN.md)。启动进程或发送请求前，校验标识符、可打印 storage ID、规范的正十进制 generation、SHA-256 digest、绝对 mount root、bearer token 和安全整数 epoch。保留 Unicode；拒绝未配对代理项，不能静默替换。

| 接口                                        | 所有权与验证                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| boot v2 / ready v2                          | 进程引导；精确校验 ready 字段集合、managedContext、seed 身份及规范 loopback origin，禁止降级 boot v1。                                           |
| POST `/internal/managed-runtime/v3/attest`  | 选定 Runtime；比较所有持久化 Workspace/storage/root 与 seed 字段，包括 incarnation。向 Broker 独立准入校验暴露已证明的 storage 身份。            |
| POST `/internal/managed-runtime/v3/context` | 选定 Runtime 与具名 Session；发送不可变 W0a binding、计算后的 digest 和 operation ID；逐字段对照原请求与接收方 incarnation 校验 receipt。        |
| tool v2                                     | 已有 Session owner 与原 execution reference。保留 context-unavailable/conflict 拒绝原因，不能伪装成 Runtime 身份替换；原执行仍可 status/cancel。 |

Context 请求和响应限制为 16 KiB，响应要求 JSON UTF-8 与 no-store，拒绝重定向和不兼容 peer。安装是显式 transport 操作，不能在 acquire 时自动调用：W0c-2 无权选择冻结的 Session 配置。成功 receipt 仅证明 context installation，不代表激活或执行授权。

## 4. 有界启动与恢复

managed-context 请求必须先持久化 resource handle，再启动进程。已有该 handle 但尚无 attested lease 的 binding 不得自动再次启动。首次失败或结果不确定的尝试进入 `RECOVERY_BLOCKED`；重复 warm 和 Broker 重启不能分配替代 generation。即使在 handle 持久化后、进程启动前崩溃，也阻止自动重试。legacy 启动策略不变。

ready 和 attestation 不兼容时关闭准入，provisioner 终止失败子进程。恢复需要原进程不能继续执行的证据以及授权生命周期操作；本切片不新增公开重试接口。已 ready Runtime 的 reconciliation 仅进行观测，并使用保存的 request/seed。

## 5. 影响组件与消费者

改动仅涉及 Java Runtime Broker 的 request/provisioner、本地 Worker 引导、HTTP transport、attestation、持久化 binding 准入、JDBC binding 存储/schema、server schema 迁移，以及相应测试和文档。RuntimeScope、Session/tool journal key、tool v2 payload、Worker 路由和公开 Session API 保持稳定。内存 repository 使用 request equality，无需 schema 迁移。

## 6. 验证与验收

- 保持所有 legacy Java Broker 测试通过；构建、类型检查并打包本地 Worker。
- 通过生产校验器消费共享 envelope fixture，覆盖小数/不安全数值、多余字段、Unicode 与 receipt 不匹配。
- 使用假 peer 和真实 Java→TypeScript 进程测试 storage 显式启用、v3 attestation 和精确 installation receipt。
- 在真实进程上验证安装重放、Session 冲突、目录缺失拒绝以及 legacy boot v1 保持原样。
- 固定 legacy request/scope hash；跨 repository 实例测试已有 schema 升级、storage 往返与篡改拒绝。
- 证明不确定启动后的重复 warm、重启均不会再启动进程；覆盖启动前持久化标记处的崩溃。
- 推送前运行定向测试、Java Checkstyle，并完成两轮干净的自审。

E2E 计划与观测记录放在 `.qwen/e2e-tests/managed-context-broker.md`。基线先使用全局 CLI，最终使用本地 bundle；不需要模型凭证或外部模型调用。

## 7. 后续依赖与开放问题

W0c-3 连接 W0b 与 W0c-1/2：读取原始 Session binding 与冻结 config/policy，验证 Registry/storage generation，单独安装配置，验证 context/config receipt，并在激活前持有 Workspace turn lease。缺少证据时执行继续关闭；legacy 未绑定解析保持独立。

Worker installation/receipt 容量限制留待后续。W0c-1 当前按 incarnation 保留证据，但没有早期草案提出的有限容量；W0c-2 不宣称已实现容量退休。任意 Shell 隔离仍需要受限 mount 或同等边界，不能只靠 realpath 检查。

O1a 正在 [#12729](https://github.com/QwenLM/qwen-code/pull/12729) 独立定义：tool v3 execute/status/cancel/acknowledge、独立的 streaming store，以及前台 Shell 的 complete-required 捕获。该方向取代本草案早先建议的独立 capability-probe 路由。O1b 依赖其评审后契约；O1c 依赖 O1a/O1b 与 W0c-1 Worker 集成。Hosted 放行还需要 W0c-3 与 O2。本 PR 不含 O1 实现。

[#12713](https://github.com/QwenLM/qwen-code/pull/12713) 是无工具的 Hosted Harness 阶段。[#12358 预览](https://github.com/QwenLM/qwen-code/pull/12358) 仅用于集成调研，不证明产品门禁已经通过。当前限定的 Broker 实现没有阻塞设计问题；发布启用与容量仍是明确的后续工作。
