# Managed Event Envelope（跨节点 EventTransport v1)

[English](./2026-10-06-managed-event-envelope.md)

> **状态：** proposed 契约，以 schema + fixtures 形式合入，含结构性非启用门禁（无生产消费方）。属于跨节点 EventTransport 设计（`2026-10-04-managed-agent-event-transport.*`，#12380 推迟的 MQ/Redis transport 范围）；本设计不宣称传输存在。

## 问题

Managed 路径上每个异步能力都是「持久资源 + 触发意图」，因此跨节点 EventTransport 只分发已提交事实——绝不当 Session 真相，绝不当浏览器游标，MQ offset 绝非恢复凭据。这些事实的运载形状就是任意后续传输选型都必须携带的唯一契约。提前冻结它，就是把去重、保序、禁泄漏语义与最终选型解耦，与 H0b 先冻结 Stage H 记录契约同式。

## 决策

1. **只载已提交事实。** 信封携带 `tenantId`/`workspaceId`/`sessionId`(由行内 `sessionKey` 平铺）、`v: 1`、`sequence`（从 1 起）、`eventId`、`kind`（与记录契约同一套 17-kind 词表精确镜像——镜像由 fixture 钉死，任一镜像漂移立即失败）、`occurredAt`、以及 `payloadRef.digest` —— payload 的**身份**（已提交记录的规范 digest)，而绝不是正文——正文留在 SQL 记录。
2. **时间。** `occurredAt` 是事件写方（recorder）随事件提交的时间戳——原事件的时间，不是 commit 时间，也不是 Session 次序；次序按 `(tenantId, sessionId, sequence)`。
3. **去重键含租户。** 精确键判等 `(tenantId, sessionId, stream, sequence)` —— `stream` 即父设计（`2026-10-04-managed-agent-event-transport.md` §6）的来源区分：journal 提交序与公开 `managed_agent_event.sequence_id` 两个计数器会用同一数字指不同事实，故 v1 写明其唯一的 stream `authoritative_journal`，公开事件通知绝不会与之判重 —— Session 只在租户内结束身份(journal head 按 `(tenant_id, session_id)` 键），因此跨租户的同 sessionId 是另一会话，判绝不重投递（fixture `different-tenant-same-key` 翻为 false 钉边界）；同键异环境仍指向同一事实。
4. **不泄内部。** 命名字段禁集（`absolutePath`、`localPath`、`pid`、`pod`、`runtimeBindingId`、`runtimeEndpoint`、`secretHandle`、`sidecar`）在形状检查前按名拒绝，逐字段带 fixture；信封不暴露任何 Runtime 内部、本地路径或凭据。
5. **从构造上不启用。** 契约不加注册项、无运行路径消费——结构性门禁（源码扫描：断言被遍历的工作区下没有生产文件按路径引用本模块）就是「传输切片自己的阶段落地前不会被悄悄挂上」的证明。它是扫描而非依赖图：re-export 与动态 specifier 不在其视野内，明言而非隐含。

## 暂不冻结（明确记录）

- `payloadRef` 只带 digest；跨版本的位置引用（durable ref)留作设计切片开放问题。
- 按 commit marker 批量分发（一次通知一批）与按事件分发，是姐妹契约问题，保持开放。

## 验证

- `npx vitest run src/managed-runtime/managed-event-envelope.test.ts` —— 100/100，含：带真 digest 的 from-row 推导;去重对（等值重投递、异环境、租户边界 false、不可解析）;每个禁泄漏字段被拒；17 种 kind 逐一一枚有效信封;每个声明边界的双侧行（sequence 下限、id 字节上限、digest 长度上限）;按字段 UTF-16/NFC/字节限/控制字符行；去重键上的 stream（journal 与公开事件绝不互判重）;schema 的 kind 枚举与记录词表相等而非超集；字面幂等键；两条构造路径的深度冻结;schema↔模块一致双向钉；结构性非启用扫描。
- 发布时全部 4 个文件 prettier 净。
