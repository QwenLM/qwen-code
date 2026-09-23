# Managed Runtime 身份证明契约基础

[English](2026-09-22-managed-runtime-attestation-contract.md) | [简体中文](2026-09-22-managed-runtime-attestation-contract.zh-CN.md)

状态：契约基础和仅提供身份证明的 worker 外壳已实现；Java Broker 接线仍是后续工作。更新日期：2026-09-23。

## 问题

预览版 Managed Runtime worker 在 Express 中注册了 `POST /internal/managed-runtime/v2/attest`，而外层 raw HTTP gate 维护另一份路由表达式。因为最初只更新了其中一份，请求在到达 Express 前就返回 404。私有身份操作不能依赖 reviewer 人工保证两份路由清单同步。

TypeScript worker 和未来 Java transport 还需要一份可共同评审的线路契约。两端各自维护的测试可能偶然都通过，但实际接受不同的 method、path、header、body 形状、大小限制或失败分类。

## 当前状态

上游 `main` 已包含 #12409 的 Hosted Harness 协议 primitive 和 Runtime Broker 状态基础，但还没有预览分支中的 Hosted profile、Java HTTP transport、Runtime provider 或 Broker-to-Harness 接线。本变更新增隐藏的、仅提供身份证明的 worker 命令，让路由契约运行在一个真实且独立持有的进程中，同时不启用公共 server mode，也不宣称 Tool execution 已 ready。

预览实现仍可作为 route set 与 404 故障的证据，但不会整块复制。后续提取这些组件并启用生产功能时，必须依赖本契约。

## 目标

- 在 typed route manifest 中只定义一次 v2 attestation method 和精确 path。
- Express 注册与 raw HTTP 放行判断都由同一个条目驱动。
- 先鉴权再解析 JSON，将请求 body 限制为 16 KiB，拒绝未知字段，并让每个响应都返回 `Cache-Control: no-store`。
- 保存语言无关的闭合 schema 和正反 fixtures。
- 通过真实 raw Node HTTP server 执行这些 fixtures，并让 Java Runtime Broker 构建读取同一批文件。
- 通过标准输入中的一份有界 boot 文档启动最小独立进程，只绑定 loopback，并通过标准输出发布不含 token 的 ready record。
- 在引入 Hosted profile 之前，不改变普通 `qwen serve`、公共 API 和现有 daemon 路由。

## 非目标

本切片不增加 Hosted profile、Runtime provider、Java `RuntimeTransport`、Broker service 集成、公共 Agent API、Session 恢复、Tool execution、Kubernetes 身份或 MySQL 状态。worker 外壳只提供身份证明，不声称 attestation 成功后生产 Runtime 已 ready。后续 Broker 集成仍需把 reconcile、attestation、数据库 CAS 和进程内 ready gate 作为一个有序操作。

## Typed Route Manifest

`OWNED_MANAGED_RUNTIME_ROUTES` 当前只包含本契约切片实际实现的一条路由：

```text
POST /internal/managed-runtime/v2/attest
protocolVersion = 2
requestBodyLimitBytes = 16384
responseBodyLimitBytes = 16384
cacheControl = no-store
```

Express registrar 从该条目读取 method、path、协议版本和 body 限制。raw HTTP gate 使用同一条目对传入 method 与未经修改的 request URL 进行比较。因此，query string、尾随斜杠、大小写变体、其他 method 和未登记 path 都会在进入 Express 前以 404 失败。

manifest 刻意不预先加入仅存在于预览分支的 health、v1 Tool、history 或 v2 Tool routes。每个操作都在提取真实 handler 的同一变更中加入。这样可以避免 manifest 声称某条路由存在，而 `main` 实际没有实现。

## Attestation 请求与响应

请求使用 bearer 鉴权和精确 lease headers：

```http
POST /internal/managed-runtime/v2/attest
Authorization: Bearer <per-generation-token>
X-Qwen-Managed-Lease-Id: <leaseId>
X-Qwen-Managed-Lease-Epoch: <positive epoch>
Content-Type: application/json
Cache-Control: no-store
```

闭合 JSON body 包含 `protocolVersion`、`provisionRequestId`、`tenantId`、`workspaceId`、`workspaceGeneration`、`workspaceCwd`、`capabilityDigest` 和 `isolationClass`。未知字段和非法 JSON 返回 400；压缩请求会被拒绝，因此 16 KiB 上限按线路字节计算，超过上限的 body 返回 413；非法凭据在解析 body 前返回 401；lease 或不可变 scope 不一致返回 409。成功响应回显不可变 scope，并增加 `runtimeInstanceId`、`runtimeIncarnation`、`leaseId` 和 `epoch`。

handler 永不返回 bearer token。token 通过等长 `timingSafeEqual` 比较。capability digest 必须采用规范的小写 `sha256:<64 hex>` 形式。请求和响应 payload 都是闭合对象，因此 v2 peer 不能静默加入另一端忽略的身份字段。

## 共享 Schema 与 Fixtures

语言无关文件位于 TypeScript 契约旁的 `packages/cli/src/serve/contracts/`：

- `managed-runtime-attestation-v2.schema.json` 固定 route metadata、闭合请求与响应形状、大小限制和结果分类。
- `managed-runtime-attestation-v2.fixtures.json` 包含规范 identity，以及凭据变体、每个不可变身份不一致、非法或空字段、精确错误码、不支持的媒体类型、charset/content encoding、超大 body 与精确路由拒绝等用例。

TypeScript 测试物化每个用例，并通过 `node:http` → raw manifest gate → Express 鉴权与 JSON 解析 → attestation handler 的完整路径发送请求。测试校验 status、分类、`no-store`、精确成功 body 和响应大小。

Java Runtime Broker 测试使用 Jackson 读取仓库中的同一批文件，固定 route metadata、大小限制、闭合字段集合、fixture 唯一性和共享状态分类。当前不增加 Java 生产 validator，因为 `main` 尚无 Java HTTP transport consumer；现在发布会形成未使用 API。未来 transport PR 必须把 fixture 断言迁入真实请求发送和响应解析逻辑，并继续读取同一文件。

## 仅提供身份证明的 Worker 外壳

隐藏命令 `qwen managed-runtime-worker` 从标准输入接收且只接收一份 JSON boot 文档。这个闭合文档包含 v1 boot 标记和不可变 attestation identity，其中包括每个 generation 独立的 bearer token。输入上限为 32 KiB，且必须在 30 秒内关闭；超时或出现未知字段都会让启动失败。通过标准输入传入 token，可避免它出现在命令参数或长期环境变量中。

进程使用同一个 attestation registrar 校验 identity 后，在操作系统分配的 `127.0.0.1` 端口监听。raw listener 由 `ownedManagedRuntimeRouteGate` 包装，因此唯一放行的操作是 manifest 中精确的 attestation route。进程输出一份闭合的 v1 ready record，其中包含 loopback URL 和 fencing identity，但永不包含 token。收到 `SIGINT` 或 `SIGTERM` 时，进程先关闭 listener 再退出。

这个外壳为下一步 Java client 和 process provisioner 提供可执行的 ownership boundary。它不加载 model、Harness、tool manifest、Session 或 workspace execution engine。后续增加任何 Tool 操作时，必须在同一个变更中加入真实 handler 和 route manifest 条目。

## 安全与失败语义

- raw gate 检查原始 URL，拒绝 query 变体，不会把它规范化为允许路由。
- 在 JSON 解析前校验 authentication 和 lease headers，减少未鉴权 parser 暴露面。
- 每个 route 与外层 gate 响应都带 `Cache-Control: no-store`，包括 4xx 响应。
- boot credential 只从大小和时间均有界的标准输入读取一次，ready record 不得泄露它；本阶段外壳只绑定 IPv4 loopback。
- `401/403` 分类为凭据失败，`400/413` 分类为协议失败，`404/405` 分类为不兼容，`409` 分类为身份冲突。未来 Broker 不能把 404 解释为暂时未 ready。
- attestation 验证应用身份信封，不是 TPM/TEE remote attestation。跨主机流量仍需要 TLS/mTLS 或等价 workload identity 和网络策略。

## 集成顺序

Hosted Runtime 按以下顺序集成：

1. 本变更启动仅提供身份证明的进程，使用 `ownedManagedRuntimeRouteGate` 包装 listener，并注册 `registerManagedRuntimeAttestationRoute`；
2. 让 Java attestation client 按共享 fixture 发送和解析数据，并施加 16 KiB 响应上限；
3. 发送凭据前先 reconcile 物理身份，然后使用原数据库 operation generation 提交 attestation 结果，最后才能打开本地 ready gate；
4. 提取每个真实 owned Tool handler，并在同一提交中把它的 route 加入 manifest；
5. 增加 Java Broker + TypeScript worker 进程 E2E，并把跨语言 gate 设为 required CI。

## 验证

聚焦 TypeScript suite 必须通过真实 TCP listener 跑完全部 fixture 用例，并把隐藏命令作为子进程启动，完成 boot input、attestation 和优雅终止。Runtime Broker Maven suite 必须读取同一 fixtures 和 schema。仓库 build 与 typecheck 必须保持通过。因为该命令是内部命令，且尚无公共 profile 启动它，所以本切片不改变普通用户可见行为。

## 验收标准

- route registrar 和 raw allow 判断中没有重复的 attestation path 字面量。
- query string、尾随斜杠、错误 method 或未知 path 在 raw gate 返回 404。
- 缺失凭据的结果优先于非法 JSON，证明鉴权先于解析。
- 超过 16 KiB 的 body 返回 413；压缩 body 以及不支持的 JSON charset 或 content encoding 按 JSON 协议错误失败；所有响应都带 `Cache-Control: no-store`。
- 未知字段、错误协议版本和非法 digest 按协议错误失败；lease 和不可变 identity 差异按冲突失败。
- TypeScript 与 Java 消费同一个 fixture 文件，并对五种分类达成一致。
- worker 拒绝非法、超大或非闭合 boot input；绑定 loopback 随机端口；输出不含 token 的 ready record；只暴露 manifest route；并能干净终止。
- 不引入 Hosted profile、Runtime provider、Broker transport、公共 API 或普通 daemon 行为变化。

## 后续边界

本变更完成可独立评审的 A1 route source、TypeScript 进程挂载和 A2 的 schema/fixture 部分。只有具体 Java client 使用共享 fixtures 验证请求发送与严格响应解析，并且 required CI lane 同时运行两端测试后，A2 才算完成。跨语言进程 E2E、重启/CAS 行为、部署身份和故障注入仍是后续验收门禁。
