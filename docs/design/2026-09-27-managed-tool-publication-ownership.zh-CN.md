# Managed 工具发布归属（O2a）

[English](2026-09-27-managed-tool-publication-ownership.md) | [简体中文](2026-09-27-managed-tool-publication-ownership.zh-CN.md)

## 状态与范围

这是统一 [O2 交付](2026-09-27-managed-tool-result-hosted-delivery.zh-CN.md) 的实施基础，基于 main `848cf5e6c`。O2a 交付闭合 publication binding/request/grant 契约、TypeScript/Java 共享 fixture、新 SQL 迁移及内部事务预留 repository。生产 HTTP 发布路由、OSS 数据传输、Session 回执接纳及 worker 调度归同一 Draft PR 的后续工作。repository 显式接收部署容量限制及现有 SQL Session/Broker authority，不新增默认启用的 bean 或 worker 能力。O2b 保留 grant 闭合的 `OPEN/FENCED/NOT_STARTED` 授权状态，另用 `producerPhase` 保存生产进度。

## 身份与授权

不可变 binding 保存完整 Session key、模型 call ID、原 execution ID、Runtime binding/reference/generation、capture 身份、精确参数资源与 payload digest、原 writer/activation、intent sequence 及 checkpoint reference。`manifest.callId` 重复 Runtime `reference.callId`；`modelCallId` 单独用于模型历史配对。同步澄清 O1a 文档，原有本地 ID 相同的行为和分段 fixture 保持不变。

精确调度 payload digest 与规范化 input digest 不同。Runtime `reference.argsDigest` 使用带原始 `sha256:` 前缀的规范化 input SHA-256。Java 验证精确 UTF-8 payload digest 及保存的参数/checkpoint 关系；TypeScript 额外使用 `managedToolDigest` 重算规范化 input。普通 HTTP 409、查不到 Runtime status 或 writer 到期都不是未启动执行的证明。

owner 请求用现有 writer token 认证并锁住 Session head。恢复已阻断的 Session 可以 fence/close，但不能 reserve/renew。reserve 和 renew 还验证最新已提交 active activation、原 intent（包括提交它的 writer generation）、原不可变 checkpoint 及当前 `await_runtime` checkpoint、资源摘要及保存的 Broker execution/binding。其他工具推进 checkpoint 后，renew 保留原 binding，并另行验证最新 checkpoint 中此 execution 仍在进行。SQL head 的 activation epoch 不充分，因为 release 可保持相同 epoch。准入逆序读取有界 journal 事务以定位最新 activation，内存最多保留一条现有有界事务；后续 ingestion 如测量表明确有需要，可增加经过验证的投影。

owner 在 reserve 前生成独立的 256-bit 随机 publication token，沿用现有 writer-secret 模式。只保存 SHA-256，响应返回 grant 元数据，不返回秘密。响应丢失时用原 binding、配额和 token 重试，不隐式轮换。上层设计已同步采用此选择，无需新增加密 token 存储。

## 操作与容量

内部操作为 `reserve`、`renew`、`fence`、`close_not_started`。请求为闭合 JSON，上限 64 KiB。reserve 包含不可变 binding 和捕获配额；producer-terminal（2,686,976 字节：terminal、manifest 和两个最终 page）与 admission（2,097,152 字节）额度分别固定预留，捕获耗尽不能挤占它们。其他操作指定原 publication 和当前 owner。grant 包含 publication ID、binding digest、状态与 expiry，不含授权秘密。

首次 reserve 要求原 Broker execution 为 `PREPARED` 且 dispatch generation 为零；执行中只允许已有预留重放/续期。O2d 必须在 claim dispatch 前检查已提交的预留，此前置校验不能代替调度互锁。reserve 仅在 binding、配额和 token 相同时幂等。同一 Session 内 publication ID、原 execution 和 capture ID 均不可重绑定。renew 保持原身份，grant 有效期不超过 writer 和 activation 到期时间。fence 不可逆并保留预留，不证明进程停止。close 要求原始 Broker 权威记录为 `SETTLED/not_started`，或 dispatch generation 为零的 `SETTLED/cancelled`；撤销 grant，并且只释放一次未用预留。新 owner 可认证自身 writer 后 fence/close 前任预留，但不能 renew 或重新 reserve 前任身份。

容量按执行、Session、tenant 和 tenant 全局活跃 capture 数限制。部署实例必须使用相同容量策略。更早的 page 计入捕获配额，最终 page 使用独立 producer 额度。所有限制必须是显式正安全整数。事务固定按 tenant capacity、Session head、publication 的顺序锁定。重复 reserve 不重复占额，失败回滚。O2a 无上传，因此 close 可释放全部未用配额。O2b 增加上传前，必须核算已用/在途/隔离字节，保留独立 admission 额度；存在字节后不能直接沿用 O2a 的 close 路径。

## 验证

实现前先运行失败的共享 fixture 测试，再由两种语言的真实 parser 验证。覆盖 ID/UTF-8/NFC/十进制 generation 边界、未知字段、范围/摘要改变、不同模型/Runtime ID，以及 grant 不含秘密。SQL 测试覆盖重启/重放、writer 与同 epoch activation release、缺失或变化的已提交证据、Broker 身份冲突、并发配额竞争、回滚、fence/revoke 和权威未启动关闭。内部 repository 测试使用真实 JDBC 事务，明确数据库是 H2 还是 MySQL。现有全局 CLI `0.24.6` 无 O2 入口，普通模型对话不作为本切片 E2E 证据。

运行 core/Java 定向测试、O1a/O1c 门禁的 core/CLI 回归、仓库 build/typecheck/bundle 及完整 diff 自审。本切片不宣称远端对象或不同宿主验收完成。提交时契约语义修改仍需 maintainer 评审。

### 本地实施证据（2026-09-27）

仓库 build、typecheck、bundle 通过。core 回归选择通过 608 项，CLI 门禁选择通过 23 项。最后的调度门禁修改后，publication 测试通过 TypeScript 42 项、Java 15 项；此前 Session Store/Flyway 回归另通过 Java 5 项。定向 ESLint 与 Java Checkstyle 通过。发现共享缓存混入同版本但不同源码的制品后，Java 依赖已从当前工作区源码重建到独立 Maven 缓存。

SQL 证据使用 H2 2.3、实际 Flyway V1–V14 和 JDBC 事务。journal/checkpoint fixture 验证 repository 读取的字段，未装配完整 TypeScript authority/model 回路。重建 repository 证明 catalog 重放，不证明进程崩溃或不同宿主恢复。本切片未验证 MySQL、OSS、HTTP 发布路由或 Hosted 调度。
