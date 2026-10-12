# Managed Event Envelope（跨节点 EventTransport v1)

[English](./2026-10-06-managed-event-envelope.md)

> **状态：** proposed 契约，以 schema + fixtures 形式合入，含结构性非启用门禁（无生产消费方）。属于跨节点 EventTransport 设计（`2026-10-04-managed-agent-event-transport.*`，#12380 推迟的 MQ/Redis transport 范围）；本设计不宣称传输存在。

## 问题

Managed 路径上每个异步能力都是「持久资源 + 触发意图」，因此跨节点 EventTransport 只分发已提交事实——绝不当 Session 真相，绝不当浏览器游标，MQ offset 绝非恢复凭据。这些事实的运载形状就是任意后续传输选型都必须携带的唯一契约。提前冻结它，就是把去重、保序、禁泄漏语义与最终选型解耦，与 H0b 先冻结 Stage H 记录契约同式。

## 决策

1. **只载已提交事实。** 信封携带 `tenantId`/`workspaceId`/`sessionId`(由行内 `sessionKey` 平铺）、`v: 1`、`stream`（v1 唯一取值 `authoritative_journal`）、`sequence`（从 1 起）、`eventId`、`kind`（与记录契约同一套 17-kind 词表精确镜像——镜像由 fixture 钉死，任一镜像漂移立即失败）、`occurredAt`、以及 `payloadRef.digest`，而绝不是正文——正文留在 SQL 记录。该 digest 是对「所通告的单个事件作为单元素列表」的规范 JSON 取 SHA-256——与提交标记那个覆盖整个事务的 `eventsDigest` 使用同一规范形式，但不是那个标记值：两者仅在单事件事务中相等，因此多事件事务中不存在与它相等的列。接收方通过对自己读回的单个事件重算 digest 来校验所通告的事实。
2. **时间。** `occurredAt` 是事件写方（recorder）随事件提交的时间戳——原事件的时间，不是 commit 时间，也不是 Session 次序；次序在同一 stream 内按 `(tenantId, sessionId, stream, sequence)` 决定。
3. **去重键含租户。** 精确键判等 `(tenantId, sessionId, stream, sequence)` —— `stream` 即父设计（`2026-10-04-managed-agent-event-transport.md` §6）的来源区分：journal 提交序与公开 `managed_agent_event.sequence_id` 两个计数器会用同一数字指不同事实。v1 写明其唯一的 stream `authoritative_journal`；携带任何其他 stream 取值（含 `public_event`）的通知在解析期就被封闭的 stream 词表拒绝（fixture `stream-public-event`），所以 journal 与公开事件的碰撞今天根本到不了去重键——v1 交付的保证是解析期拒绝，而不是键上的 `stream` 项：该项在单成员词表下恒真，只在引入第二个 stream 后承重，那次改动必须同时补上有区分度的去重 fixture。Session 只在租户内结束身份(journal head 按 `(tenant_id, session_id)` 键），因此跨租户的同 sessionId 是另一会话，判绝不重投递（fixture `different-tenant-same-key` 翻为 false 钉边界）；同键异环境仍指向同一事实——且每个去重行都声明其操作数的可解析性，`false` 恒等于「因声明的原因被拒」，而非操作数退化得根本到不了比较。
4. **不泄内部。** 命名字段禁集（`absolutePath`、`localPath`、`pid`、`pod`、`runtimeBindingId`、`runtimeEndpoint`、`secretHandle`、`sidecar`）在形状检查前按名拒绝，逐字段带 fixture；信封不暴露任何 Runtime 内部、本地路径或凭据。
5. **从构造上不启用。** 契约不加注册项、无运行路径消费——结构性门禁（源码扫描：断言没有生产文件 import 本模块）就是「传输切片自己的阶段落地前不会被悄悄挂上」的证明。扫描遍历每个 workspace 包的 `src/`（无 `src/` 时退而遍历包树，由此覆盖 `packages/web-shell/client`），外加仓库根的 `scripts/` 与 `integration-tests/` 树，只跳过 `node_modules/`、`dist/`、符号链接与测试文件，并用 TypeScript AST 匹配 import/export/动态 `import()`/`require()` 说明符而非裸文本，因此注释、字符串与插值模板既不能掩盖也不能伪造 import；消失的 workspace 会让门禁失败而不是被静默跳过。盲区明言而非隐含：re-export、计算或插值式说明符、符号链接（决不进入，目录链接会隐藏其目标）、以及扫描扩展名集之外的语言——父设计指派的 Java 镜像在构造上就不在这次扫描的视野内。

## 暂不冻结（明确记录）

- `payloadRef` 只带 digest；跨版本的位置引用（durable ref)留作设计切片开放问题。
- 按 commit marker 批量分发（一次通知一批）与按事件分发，是姐妹契约问题，保持开放。

## 验证

- `npx vitest run src/managed-runtime/managed-event-envelope.test.ts` —— 106/106，含：带真 digest 的 from-row 推导;去重对（等值重投递、异环境、租户边界 false、不可解析操作数），每个操作数的可解析性先声明、先断言，退化的行无法静默通过；每个禁泄漏字段被拒；17 种 kind 逐一一枚有效信封;每个声明限值的接受侧与拒绝侧边界行（`sequence` 下界 `sequence-one`/`sequence-zero` 与安全整数上界 `sequence-at-max`/`sequence-max-safe`、`occurredAt` 上界 `occurred-at-exactly-max`/`occurred-at-over-max`、stable-id 字符与 UTF-8 字节双口径上界 `session-id-exactly-512-chars` 与 `session-id-exactly-512-bytes` 对四行 `*-over-512-bytes`），且 schema 的 `stableId.maxLength` 与 `occurredAt.maximum` 字面量与 `MANAGED_SESSION_LIMITS` 双向钉死；四个 id 字段逐字段 UTF-16/NFC/字节限/控制字符行；stream 词表端到端钉死（模块常量、fixture `streams`、schema 顶层 `streams` 常量与嵌套 `envelope.properties.stream.enum`），`public_event` 在解析期被拒——v1 的 journal-versus-public 保证由该解析拒绝交付而非任何去重行，引入第二个 stream 时须补有区分度的去重行;schema 的 kind 枚举与记录词表相等而非超集；字面幂等键；两条构造路径的深度冻结;schema↔模块一致双向钉（beyond-schema 各行点名）；结构性非启用扫描。
- 发布时全部 4 个文件 prettier 净。
