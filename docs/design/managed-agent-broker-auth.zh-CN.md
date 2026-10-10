# Managed Agent Broker：已认证主体与 Broker 下发的凭证

[English](managed-agent-broker-auth.md) | [简体中文](managed-agent-broker-auth.zh-CN.md)

状态：已在本地实现，2026-10-02；验证结果记录在
`.qwen/issues/issue-13180.md`。源码基线：`de2612434a`。
跟踪 [#13180](https://github.com/QwenLM/qwen-code/issues/13180)。

## 1. 问题陈述

Managed Agent Runtime Broker（`packages/sdk-java/managed-agent-server`）
目前信任客户端自证的身份和客户端自铸的凭证。当 broker 在没有网关的
情况下可达时，五个缺口组合成对任意 hosted 会话持久 transcript 的
跨租户读写：

1. **租户/操作者身份来自自证头。** `TenantContextFilter` 原样接受
   `X-Qwen-Tenant-Id`，仅当 principal 已存在时才交叉校验 actor。
   OpenAPI 契约中 trusted-actor 方案标为
   `x-qwen-implementation-status: planned`——它所假设的网关并未随
   仓库交付，而已交付的 dev/E2E 拓扑（Web Shell 的 `?tenant=`、
   vite dev 代理、`trusted-actor-header` 配置）恰好都是无网关形态。
2. **writer 凭证是自铸的。** harness 自己生成 writer token
   （`packages/core/src/managed-runtime/http-managed-session-store.ts`
   中的 `randomBytes(32)`），broker 在首次 acquire 时登记其哈希
   （`ManagedSessionStore.acquireWriter`，首写者赢 TOFU）。在任何
   租约空窗（最长 300 秒）内，能触达端口且知道
   `(tenantId, workspaceId, sessionId)` 的人都能夺取 writer 身份
   并重写会话的持久历史。
3. **内部面与公网面共用端口。** `/internal/**`（Managed Session
   store 与 tool publications）与 `/v1/agents/**` 由同一连接器
   提供服务；没有独立监听器，也没有对监听地址的部署守卫。
4. **审批属主不含 hosted 会话。** `ManagedActionService.respond` →
   `ManagedActionStore.requireOwner` 只匹配
   `managed_workspace_create_command` 行，因此 hosted（非 workspace）
   会话没有持久属主、HTTP 应答永远走不通；而 workspace 会话的校验
   只是把可猜测的 actor-id 值与自证头身份做比较。
5. **TypeScript 客户端静默允许明文传输。**
   `createHttpManagedSessionStores` 对任意主机都接受 `http://`
   base URL，因此非回环部署下 writer token 明文过网且无任何警告。

## 2. 目标与非目标

目标：

- G1. 公网面上的租户/操作者身份来自 broker 自身可验证的已认证主体
  （不依赖外部网关）。
- G2. writer 凭证由 broker 在会话/运行时创建时下发，并绑定
  `(tenantId, workspaceId, sessionId)`；配置绑定密钥后自铸 token
  不再可用。
- G3. `/internal/**` 可绑定到独立的仅回环监听器，且 broker 在启动时
  拒绝不安全的监听地址组合。
- G4. 每个会话都有持久的创建者记录；审批应答校验该记录，hosted
  会话可通过 HTTP 应答。
- G5. TypeScript 客户端拒绝非回环主机的明文 `http://` broker 地址，
  除非显式 opt-in。

非目标：

- runtime-broker 自身的单 token HTTP server（由另一 issue 单独跟踪）。
- 真正的 OIDC/SSO 网关、mTLS、密钥轮换工具，以及超出现有 actor
  校验的多租户 ACL 建模。
- 改变已交付的回环 dev/E2E 拓扑：它们无需新配置即可继续工作。

## 3. 信任模型

两个 HTTP 面有不同的调用方和不同的保护方式：

| 面     | 路由                                                                                 | 调用方                     | 本次变更后的保护                              |
| ------ | ------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------- |
| 公网面 | `/v1/agents/**`、`/api/agent/web-shell/v1/**`                                        | 浏览器、运维工具、代理     | 签名主体（G1）或仅回环的 open 模式            |
| 内部面 | `/internal/managed-session-store/v1/**`、`/internal/managed-tool-publications/v1/**` | Hosted harness（Qwen CLI） | writer 绑定凭证（G2）；监听器默认仅回环（G3） |

内部面不需要请求签名：writer 绑定凭证已绑定
`(tenantId, workspaceId, sessionId)`，在内部调用上伪造租户头只会
推导出一个不同的期望凭证而失败。因此签名密钥永远不会分发给
harness。

## 4. 设计

### 4.1 认证模式与签名主体（G1）

新增配置组 `qwen.managed-agent.auth`：

| 键                    | 环境变量                                      | 默认值  | 含义                                  |
| --------------------- | --------------------------------------------- | ------- | ------------------------------------- |
| `mode`                | `QWEN_MANAGED_AGENT_AUTH_MODE`                | `auto`  | `auto`、`open` 或 `signed`            |
| `signing-key`         | `QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY`         | 空      | `signed` 模式的 HMAC 密钥，>= 32 字节 |
| `allowed-drift`       | `QWEN_MANAGED_AGENT_AUTH_ALLOWED_DRIFT`       | `5m`    | 签名时间戳容差                        |
| `allow-insecure-bind` | `QWEN_MANAGED_AGENT_AUTH_ALLOW_INSECURE_BIND` | `false` | 文档明确标注为危险的逃生门            |

启动时的模式解析：

- `open`：现状行为——按自证接受 `X-Qwen-Tenant-Id`，可选的
  `trusted-actor-header` 替身提供 actor。
- `signed`：新的 `SignatureAuthFilter`（排在
  `TrustedActorHeaderFilter` 之前）要求公网面每个请求携带三个头：
  `X-Qwen-Actor-Id`（actor 身份，必需）、`X-Qwen-Signature-Timestamp`
  （epoch 秒，须在 `allowed-drift` 内），以及 `X-Qwen-Signature`，
  计算方式为：

  ```
  X-Qwen-Signature: v1=<小写 hex HMAC-SHA256>(
      "qwen-broker-auth-v1\n" + METHOD + "\n" + requestURI + "\n"
      + queryString + "\n" + tenantId + "\n" + actorId + "\n" + timestamp
      + "\n" + 原始请求体的 SHA-256（小写 hex）+ "\n" + idempotencyKey)
  ```

  `requestURI` 是未解码的路径，不含查询串；`queryString` 是原始查询串
  （缺省为空）；`idempotencyKey` 是 `Idempotency-Key` 头的值（缺省为
  空）。对请求体和幂等键签名意味着捕获的签名无法转移到其他方法、
  路径、查询串、租户、actor 或请求体；配方之外的头（如
  `Last-Event-ID`、`Accept`）在漂移窗口内仍可变，因此捕获的读签名
  可在这些头选择的游标值上重放。

  验证成功后过滤器安装 `AuthenticatedTenantActor` principal
  （租户与 actor 来自现已认证的头）；失败则以标准错误信封应答
  `401 authentication_required` 或 `401 invalid_signature`。随后
  `TenantContextFilter` 按现状交叉校验 principal，因此无需改动
  任何 controller。

  两个 fail-closed 细节：覆盖判定使用路由后的路径
  （`UrlPathHelper.getPathWithinApplication`，经 `PublicSurface`
  与租户过滤器共享），因此裸集合路由 `POST /v1/agents` 与归一化
  拼写（百分号编码、路径参数）都无法绕过，而规范串仍对原始请求
  URI 签名；重复的 `Idempotency-Key` 头以 `400 invalid_request`
  拒绝，因为 Servlet 契约会签第一个值而 controller 绑定的是逗号
  拼接值。缓冲的请求体按请求受
  `qwen.managed-agent.auth.max-signed-body-bytes`（默认 10 MiB）
  限制——超限请求在签名比对之前应答 `413 payload_too_large`。
  认证前的聚合缓冲上限为该值乘以 Servlet 工作线程数
  （`server.tomcat.threads.max`，默认 200），再乘每请求的缓冲增长
  系数（声明长度的请求体约 2 倍，chunked 约 3 倍）；内存紧张的
  环境可调低两者之一。最后，过滤器转发的请求把 JSON 媒体类型
  钉在 UTF-8：`Content-Type` 的 charset 参数不在签名内，非
  Unicode 字符集本可引导 JSON 解码器持久化出与已签字节不同的
  内容（JSON 按 RFC 8259 定义即 UTF-8），因此无论声明何种
  charset，链路观察到的都是 `application/json;charset=UTF-8`。

- `auto`：当 `server.address` 为回环地址（交付默认值
  `127.0.0.1`）时解析为 `open`，否则启动失败并点名需要 `signed`
  模式。这使所有已交付的 dev/E2E 拓扑继续可用，同时生产监听地址
  不可能在无认证的情况下启动。

启动守卫（全部快速失败并点名属性）：

- `mode=auto` 或 `mode=open` + 非回环 `server.address` + 未设
  `allow-insecure-bind`。
- `mode=signed` + `signing-key` 缺失或过短。
- 已解析模式为 `signed` 时配置了 `trusted-actor-header`（配置矛盾：
  头替身不得能在签名过滤器之后注入 principal）。
- 配置了非空的 `server.servlet.context-path` 或非根的
  `spring.mvc.servlet.path`（路径前缀过滤器假设根挂载，否则会被
  静默绕过）。
- `allowed-drift` 低于 1 秒（会被截断为零窗口）。
- 设置了 `internal-server.port` 时，回环的 `session-store.base-url`
  指向其他端口（harness 的 store 调用会全部 404）。
- `harness.enabled` 且 `harness.base-url` 为非回环明文 http（attach
  载荷携带下发的 writer 凭证）。
- `tool-publication.enabled` 且 `service-base-url` 为非回环明文
  http（runtime 携带 writer 凭证访问发布面）。
- `session-store.enabled` 且 `session-store.base-url` 的主机落在客户端
  的纯字面量回环集（`localhost`、`*.localhost`、`127.0.0.0/8`、
  `[::1]`）之外、又未设 `session-store.allow-insecure-http` 的明文
  http——所有 harness 都会在 attach 时拒绝该 URL，因此 broker 在
  启动时直接拒绝。

`allow-insecure-bind` 会同时停用其中四项守卫（公网绑定、内部面
binding key、harness 传输、发布面传输）；启动 posture 行以
`skipped=...` 列出被跳过的守卫，使其爆炸半径在日志中可见。

OpenAPI 契约新增 `qwenSignature` apiKey 方案（`X-Qwen-Signature`），
其描述固定规范串与 `401` 错误码；`trustedActor` 方案对外部网关
形态保持 `planned` 状态，并注明 `signed` 模式认证的是同一对头。

### 4.2 Broker 下发的 writer 绑定凭证（G2）

新增配置 `qwen.managed-agent.session-store.binding-key`（环境变量
`QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY`），默认空；设置时至少
32 字节（更弱的密钥可被一条观察到的 token 离线爆破）。

配置后，会话的 writer token 是推导出来的，而不是自选的：

```
writerToken = "qwt1_" + base64url-nopad(HMAC-SHA256(bindingKey,
    "qwen-managed-writer/v1\0" + tenantId + "\0" + workspaceId
    + "\0" + sessionId))
```

共 48 个字符，落在两侧现有的 `^[A-Za-z0-9_-]{32,512}$` 契约内。
token 刻意不含 writer id：以新 boot id 重启的 harness 可在旧租约
到期后用同一凭证重新 acquire，恢复路径继续可用。

- 新的 `WriterCredentialPolicy` bean 负责
  `issue(tenant, workspace, session)` 与
  `require(tenant, workspace, session, token)`。当绑定密钥已配置且
  出示的 token 不匹配时，`require` 抛出 `403
writer_credential_invalid`（常数时间比较）。密钥为空时保持
  现有 TOFU 行为不变。
- `ManagedSessionStore` 中所有接收 writer token 的入口
  （`acquireWriter`、`renewWriter`、`sealWriter`、`blockRecovery`、
  `commit`、`restore`、`transactions`、`readResource`、
  `publishToolResult`，以及 `ToolPublicationStore` 的
  publication-writer 路径）都经由该策略校验 token。每个调用点
  都已携带 workspace id，因此 API 形状不变。
- 下发经由现有 attach 载荷：
  `QwenHostedHarnessConnector.managedSessionStore(...)` 把签发的
  token 放入 `ManagedSessionStoreConnection`（新增可选
  `writerToken` 字段，序列化为
  `managedSessionStore.writerToken`），TS 桥解析器
  `parseBridgeManagedSessionStore` 接受该可选字段，
  `hosted-harness-session.ts` 将其传给
  `createHttpManagedSessionStores({ writerToken })`（该方法本来就
  接受显式 token）。未收到下发 token 的客户端继续自铸；只要
  绑定密钥已配置，broker 就会拒绝自铸 token，两侧不会静默失配。

已存储的 `lease_token_hash` 列职责不变（renew/seal 一致性）；绑定
只决定哪个 token 可以被出示。

### 4.3 独立内部监听器与监听地址守卫（G3）

新增配置 `qwen.managed-agent.internal-server`：

| 键        | 环境变量                                     | 默认值      | 含义         |
| --------- | -------------------------------------------- | ----------- | ------------ |
| `port`    | `QWEN_MANAGED_AGENT_INTERNAL_SERVER_PORT`    | `0`（禁用） | 独立监听端口 |
| `address` | `QWEN_MANAGED_AGENT_INTERNAL_SERVER_ADDRESS` | `127.0.0.1` | 监听绑定地址 |

- 当 `port > 0` 时，一个 `WebServerFactoryCustomizer` 添加第二个
  Tomcat 连接器，`InternalSurfaceConfiguration.RoutingFilter`
  （最高优先级）按 `request.getLocalPort()` 路由：公网连接器上的
  `/internal/**` 应答 `404`，内部连接器上非 `/internal/**` 的
  请求应答 `404`。面分类基于路由后的路径
  （`PublicSurface.pathWithinApplication`，即路由器自身解析出的
  段），因此 `/%69nternal/...`、`/internal;/...` 等被 Spring 映射到
  内部 handler 的拼写无法跨越监听器边界——`Content-Type` 中的字符集
  也无法扭曲分类，因为这些段来自路由器固定的 UTF-8 解码。
- 当 `port = 0` 时，保留现有单端口形态。
- 启动守卫：任何非回环监听地址（公网或内部）都要求相应保护——
  公网面要求 `signed` 模式，内部面要求已配置 `binding-key`——
  除非设置了 `allow-insecure-bind`。因此未配置绑定密钥时，内部面
  在构造上就是仅回环的。
- 另有两条快速失败守卫：`internal-server.port` 必须与 `server.port`
  不同（路由过滤器按本地端口分类，同号不同址会让公网地址服务
  `/internal/**`）；签名密钥必须与 binding-key 不同（持有签名密钥者
  不得能铸造 journal 写入凭证）。

### 4.4 审批的持久会话属主（G4）

- Flyway `V40__managed_session_creator.sql`：
  `ALTER TABLE managed_agent_session ADD COLUMN creator_actor_key
VARBINARY(2048) NULL;`（与
  `managed_workspace_create_command.actor_id` 同类型）。
- `ManagedAgentStore.insertSession` 已接收 `actorId`，且 hosted 与
  workspace 会话共用同一个插入路径；现在它在 actor 存在时一并写入
  `creator_actor_key`。hosted 的 `createSession` 服务方法及其
  controller 新增来自 `TenantContext` 的可空 `actorId`，使 hosted
  会话也记录创建者。
- `ManagedActionStore.requireOwner` 按序解析属主：
  1. 会话行的 `creator_actor_key`——存在时必须与调用方的 actor
     key 相等；
  2. 遗留的 `managed_workspace_create_command` 行（迁移前会话的
     回退，其 creator 列为 NULL）；
  3. 两者都没有（open 模式下的匿名创建，或迁移前的 hosted 会话）——
     放行租户内任意调用方，与非 workspace 会话现有的租户级读语义
     一致。

  这使 hosted 审批应答能通过 HTTP 走通，并把 workspace 审批绑定到
  已认证 actor（G1）而非自证头身份，堵住“可猜测 actor”缺口。

### 4.5 TypeScript 客户端传输守卫（G5）

`ManagedSessionStoreHttpClient` 拒绝协议为 `http:` 且主机名非回环
（`localhost`、`*.localhost`、`127.0.0.0/8`、`[::1]`）的 base URL，
除非传入新选项 `allowInsecureHttp: true`。
`BridgeManagedSessionStore` 新增对应可选布尔字段
`allowInsecureHttp`，由 broker 的
`qwen.managed-agent.session-store.allow-insecure-http` 配置
（环境变量 `QWEN_MANAGED_AGENT_SESSION_STORE_ALLOW_INSECURE_HTTP`）
产生，经 `ManagedSessionStoreConnection` 序列化进 attach 载荷，
使有意在受信网络内提供明文服务的 broker 可以声明；字段缺省视为
false。报错信息点名该选项，使补救方式可被发现。客户端
`writerToken` 自铸路径保留，供未配置绑定密钥的回环部署使用。

### 4.6 加固开发替身

- `TrustedActorHeaderFilter` 仅在已解析认证模式为 `open` 时激活
  （`signed` 模式下未签名请求根本到不了它，且启动守卫禁止该配置）。
  其 javadoc 中的警告变成强制规则。
- 匿名幂等域折叠：`signed` 模式下 actor 总是已认证的，因为
  `SignatureAuthFilter` 要求公网每个请求都携带 `X-Qwen-Actor-Id` 头
  （否则应答 `401 authentication_required`），因此
  `SessionLifecycleService.actorDigest` 与
  `ManagedActionService.respond` 现有的匿名折叠只会发生在 `open`
  模式——即它所服务的本地部署。

## 5. 兼容性与发布

- 已交付的回环拓扑零配置兼容：`auto` 解析为 `open`；绑定密钥为空
  保持 TOFU；内部端口禁用；匿名创建仍不记录属主。
- 启用 `binding-key` 对每个部署是一次性切换：harness 必须经 broker
  attach（由 broker 下发 token）；直连 store 的客户端须被授予推导
  token。服务器启动时记录解析出的模式与守卫结果。
- 在公网面启用 `signed` 模式需要在浏览器流量前放置持有签名密钥的
  代理或 sidecar；签名配方即 §4.1 固定的三头形式。
- 现有数据库经 V40 迁移；迁移前的会话通过遗留属主回退继续工作。

## 6. 风险与缓解

- **时间戳窗口内的重放。** HMAC 覆盖方法、路径、查询串、租户、
  actor、时间戳、请求体摘要与幂等键，因此捕获的签名无法转移到
  其他方法、路径、查询串、租户、actor 或请求体。残余风险是窗口
  （5 分钟）内的重放，包括携带未签名头（`Last-Event-ID`、
  `Accept`、`Range`）重放同一路由的不同分页：一个被捕获的读签名
  在过期前可遍历该路由的游标空间。内部写操作另有幂等键。对无网关
  部署而言可接受；nonce 缓存与对游标头签名列为后续工作。
- **绑定凭证对每个会话是静态的。** 单个 token 泄露只影响单个会话；
  轮换方式 = 轮换 `binding-key`（一次性切换）。创建时存储每会话
  随机密钥是被否决的替代方案，原因是额外的表和恢复复杂度。
- **守卫对罕见但合法的绑定（如 Pod 网络）误伤。**
  `allow-insecure-bind` 是文档化的逃生门；启动报错会点名它。
- **第二连接器漂移**（之后新增的内部路由必须落在 `/internal/`
  前缀下）。路由过滤器只匹配 `/internal/` 前缀，并有契约测试
  覆盖双向断言。

## 7. 验证计划

- 按项编写 Java 单元/集成测试：签名过滤器的接受/拒绝与排序；模式
  解析与每个启动守卫；绑定凭证的签发/校验，包括重启后重新
  acquire 与跨作用域拒绝；内部监听器的双向路由；属主回退链
  （已迁移、遗留、匿名）与 hosted `respond` 成功；`signed` 模式下
  拒绝匿名折叠。
- TypeScript 测试：回环地址分类表、未 opt-in 时拒绝、opt-in 后
  接受、桥载荷携带 `writerToken` 的往返。
- OpenAPI 契约以散文形式（方案 + 共享 `Unauthorized` 组件描述）记录
  新的 `qwenSignature` 方案与 401 错误码；web-shell 生成客户端按契约
  重新生成，其一致性测试（`managed-agent-api.test.ts`）对漂移失败。
- E2E：现有 dev 拓扑（`qwen` CLI + 回环 Web Shell）零新配置可用；
  针对非回环地址做一次 signed 模式冒烟。

## 8. 验收标准

1. `mode=signed` 时，无有效签名的公网请求得到 `401`；有有效签名时，
   actor principal 驱动 ACL 与审批校验。
2. 配置 `binding-key` 后，自铸 writer token 无法 acquire 任何会话的
   writer——包括租约空窗期——而 broker 下发的 token 可以。
3. 设置 `internal-server.port` 后，公网端口上 `/internal/**` 不可达；
   公网地址非回环且为 open 模式时，broker 拒绝启动。
4. hosted 会话的审批可由其创建者经 HTTP 应答，且其他 actor 不能；
   无属主记录的会话（open 模式匿名创建，或 V40 之前创建）允许租户内
   任意调用方应答，与其读 ACL 一致；迁移前的 workspace 会话保持现有
   行为。
5. `createHttpManagedSessionStores({ baseUrl: 'http://<非回环>' })`
   抛出异常，除非 `allowInsecureHttp: true`。

## 9. 待决问题

- 签名请求是否需要 nonce 缓存（超出 5 分钟窗口的防护）？
- `binding-key` 轮换采用上一密钥校验窗口，还是一次性切换？
- 当 harness 能持有密钥后，`signed` 模式是否也应覆盖内部面，还是
  绑定凭证长期足够？
