# Managed Agent Turn 查询（阶段 D5）

[English](2026-09-28-managed-agent-turn-queries.md) | [简体中文](2026-09-28-managed-agent-turn-queries.zh-CN.md)

状态：已在本次变更中实现
日期：2026-09-28
Issue：[#12867](https://github.com/QwenLM/qwen-code/issues/12867)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
基于：[API 契约（D1）](2026-09-27-managed-agent-api-contract.zh-CN.md)、[Session 查询（D2）](2026-09-27-managed-agent-session-query.zh-CN.md) 与 [持久生命周期（D4）](2026-09-28-managed-agent-durable-lifecycle.zh-CN.md)

## 1. 问题

Session 的每个 Turn 都保存在 `managed_agent_turn` 中，但公共 API 只展示 Session 的 `active_turn`。契约中的 Turn 列表与详情 `listTurns`、`getTurn` 在契约 v1.19 中仍为 `planned`，因此客户端无法分页浏览 Session 之前的 Turn，也无法按 ID 读取某个 Turn。

#12867 把 D5 定义为 `GET turns` 与 `GET turns/{turnId}`：基于 `managed_agent_turn` 的只读模型，遵循契约的游标与 limit 规则。它的验收条件是两条路由改为 `implemented`，且跨租户读取返回 `404`。

## 2. 目标

- 在公共入口上提供两条路由，使用 Session 的 `active_turn` 已在使用的 `PublicTurn` 视图。
- 按契约的列表规则分页：不透明游标，limit 为 1 到 100、默认 20，并返回 `has_more` 与 `next_cursor`。
- 使用与其他 Session 读取相同的检查。

## 3. 非目标

- `PublicTurn` 的持久准入字段（`operation_id`、`admission_stage` 与 `delivery_state`）。它们属于 D7，仍为 `planned`。
- WebShell 的 Turn 读取。契约没有定义；WebShell 通过其 Session 与 transcript 路由读取 Turn。
- 读权限之外的角色检查，它们等待 #12867 的 Q4。读取一个 Turn 只需要读取其 Session 所需的权限，因此在一个租户内，任何 actor 都能读取未绑定 Workspace 的 Session 的 Turn，与它能读取该 Session、其事件和 Item 一样。契约第 10 节与契约收敛第 6 节要求在生产启用前做得更多；Q4 确定的角色来源会把这些读取和其他读取一并覆盖。
- `recovery_blocked` 状态。契约的枚举列出了它，但服务端从不保存它；恢复被阻塞的 Turn 以错误码失败。
- Turn 分页用的索引（4.4）。

## 4. 决策

### 4.1 契约 v1.20

- `listTurns` 与 `getTurn` 改为 `implemented`。与 `getSession` 一样，它们为下文的校验错误和缺少租户声明 `400`，为租户过滤器的 `actor_scope_mismatch` 声明 `403`。描述写明排序、游标与错误码。
- `PublicTurn` 的三个 D7 字段仍为 `planned`。已知差异文件不变，生成的 WebShell 类型也不变，因为生成器只输出 WebShell 路由用到的类型。

### 4.2 排序、游标与 limit

每页按从新到旧列出 Turn：先按毫秒级的创建时间，再按 Turn ID，均为降序。服务端挑选 Session 最新 Turn 时已经使用这个顺序，Task 列表也是如此。`created_at` 以整秒显示创建时间，因此同一秒内创建的两个 Turn 可能以任一种 ID 顺序列出。

这两个键在受理后都不会改变，因此分页是键集分页：对读取第一页时已经存在的 Turn，任何一页都不会重复或跳过。客户端分页期间受理的 Turn 通常排在游标之前，出现在新的第一页上。只有当它的创建时间不晚于游标的创建时间时，它才会出现在后面的某一页：受理它的服务器时钟落后，或者它与游标所指的 Turn 创建于同一毫秒且 ID 更小。

游标是一页最后一个 Turn 的 `createdAt:turnId` 的 base64url 形式，与 Task 游标相同。服务端只接受这种形式的游标（带不带 base64 填充均可）：不带前导零、能放进 long 的十进制创建时间，以及由 `A-Z`、`a-z`、`0-9`、`_`、`-` 组成的 1 到 64 个字符的 Turn ID。其他任何形式都返回 `400 invalid_cursor`；与 Session 列表一样，空游标或空白游标读取第一页；Task 列表则拒绝空白游标，并且先检查 Session 再校验请求。格式正确的游标即使不是服务端为这个 Session 签发的（例如取自另一个 Session），也会用来定位分页：与 Session 和 Task 游标一样，游标不绑定到 Session。它只按时间与 ID 定位，不泄露任何信息，而且每一页都会重新检查 Session，因此游标不会比读权限活得更久。

limit 为 1 到 100，默认 20。与其他列表一样，超出该范围的 32 位整数返回 `400 invalid_limit`，不是 32 位整数的值返回 `400 invalid_request`。与它们一样，limit 经过 Spring 的整数转换，它也接受正负号、前后空格和十六进制写法。最后一页的 `next_cursor` 为 `null`。

### 4.3 字段与检查

- Turn 的读取结果与 Session 的 `active_turn` 相同：`id`、`object`（`agent.turn`）、`session_id`、`input_item_id`（`item_<turnId>_input`）、小写的 `status`（`accepted`、`running`、`cancelling`、`completed`、`failed` 或 `cancelled`）、以秒为单位的 `created_at` 与 `completed_at`，以及 `error_code`。
- 读取不包含输入。存储只查询视图需要的列，从不解析 Turn 的输入，因此很长的输入不会拖慢分页，存储的输入无法解析的 Turn 也照样可以读取。
- 以下情况读取返回 `404 session_not_found`：未知的 Session、其他租户的 Session、已删除的 Session（其墓碑只保留 operation 可读，见 D4），以及 actor 无读权限的 Workspace 绑定 Session。已关闭或已归档 Session 的 Turn 仍可读取。
- 当 Session 没有这个 Turn 时，`getTurn` 返回 `404 turn_not_found`，该 Turn 属于另一个 Session 时也是如此；Turn ID 超过路径 schema 规定的 64 个字符时返回 `400 invalid_request`，长度按字符而不是 UTF-16 单元计算。二进制排序规则会忽略尾部空格，因此存储会把查到的 Turn ID 与请求的 ID 比较：只在尾部空格上不同的 ID 什么也找不到。
- 与所有路由一样，租户过滤器返回 `403 actor_scope_mismatch`，缺少租户时返回 `400`。
- 先校验请求，再检查 Session：格式错误的请求无论 Session 如何都得到 `400`，格式正确但无法读取其 Session 的请求得到 `404`。

### 4.4 不加索引

主键 `(tenant_id, session_id, turn_id)` 把一页限定在一个 Session 的行上，数据库按创建时间对该 Session 的 Turn 排序，现有的最新 Turn 查询也是这样做的。`(tenant_id, session_id, created_at, turn_id)` 上的索引需要一个 Flyway 迁移，而在飞的 PR 已经在争用迁移版本号；等 Session 的 Turn 多到排序开销显著时，再随后续迁移添加。

## 5. 测试

- **契约测试。** 一个新 Session 运行一个 Turn，之后再写入一个失败的 Turn。场景分页读取这两个 Turn，读回其中一个并与它的列表条目比较，并在两条路由上试探 `400`（游标、limit、缺少租户、过长的 ID）、`403` 与 `404`（其他租户、未知 Turn）。每个响应都按 schema 校验。
- **Turn 查询测试。** 六个场景：对最旧的 Turn 拥有最大 ID 的一组 Turn，以 1 到 6 的每个 limit 从新到旧分页，使只按 ID 排序的结果不同，分页边界也落在两个创建时间相同的 Turn 之间，并检查每个边界上的 `has_more` 与 `next_cursor`、25 个 Turn 时默认每页 20 个，以及空游标和空白游标；每种存储状态及其结果字段，且每个列表条目都等于该 Turn 的详情；存储的输入不是 JSON 的 Turn；limit 与游标校验（也在未知 Session 上进行，以表明请求先被校验），包括不是 32 位整数的 limit、溢出的创建时间、位于所有 Turn 之外的游标、指向最旧 Turn 的游标、带 base64 填充的游标，以及 Turn ID 为 64 个字符的游标；Session 检查（另一个 Session 的 Turn、64 与 65 个字符的 ID、33 与 65 个基本多文种平面之外的字符、带尾部空格的 ID、未知 Session、其他租户、已归档与已删除的 Session）；以及有读权限和无读权限时读取绑定 Session。
- **MySQL 测试。** 在 MariaDB 与 MySQL 上，每页两个地分页读取五个 Turn，其中最旧的 ID 最大，另有两个创建时间相同、ID 只有大小写不同。顺序遵循二进制排序规则，查找时 ID 的大小写必须完全一致；带尾部空格的 ID 什么也找不到，尽管排序规则在 SQL 中会匹配它；用其他租户名读取也什么都找不到。

## 6. 兼容性

- 新增两条路由；已有响应都不变。
- 契约 v1.20.0。没有迁移，生成的 WebShell 类型不变。

## 7. 验证

- Managed Agent 服务的 `mvn test`（176 个测试）与 Checkstyle 通过。
- `ManagedAgentMySqlIT` 在 CI 使用的 `mariadb:10.11.18` 与 `mysql:8.4` 上均 14/14 通过。去掉精确的 Turn ID 比较后，它在两个数据库上都会失败。
- 重新生成 managed API 类型后没有变化。
- 24 个变异各自让某个测试失败：按从旧到新排序；不按 Turn ID 打破并列；游标重复返回它指向的 Turn，或跳过与它创建时间相同的 Turn；键集忽略创建时间；恰好填满的最后一页报告还有更多；不检查 limit；游标接受前导零；溢出的创建时间返回其他错误；列表或详情跳过 Session 检查，或先于请求校验检查 Session；默认 limit 为 100；详情忽略 Session 或读取输入；查询过长的 ID；按 UTF-16 单元计算 ID 长度；最后一页仍给出游标；拒绝空游标或空白游标；因填充或因 Turn ID 超过服务端签发的长度而拒绝游标；以及忽略带有这种 ID 的游标。

## 8. 后续工作

- D7：Turn 的持久准入字段。
- Session 变长之后，随后续迁移为 Turn 分页添加索引。
- 如果 WebShell 的某个视图需要，再提供 WebShell 的 Turn 读取。
- Q4 有答复后再做角色检查；读取只需要读权限。
- 为 Session、Task 与 Turn 列表提供同一个键集游标编解码器，最迟在另一个资源（例如规划中的 Artifact 或 Action 列表）增加第四份副本之前；Workspace 列表已经在用它自己的游标分页。三者编码相同但解码不同：Session 列表接受任意 long 与任意非空 ID，Task 列表拒绝空白游标并先检查 Session。共享的编解码器必须有意识地决定：Session 列表是否保留它宽松的语法（它已上线，但契约并未描述它），以及 Task 列表是否像 Session 与 Turn 列表那样把空白游标当作第一页，并像 Turn 列表那样先校验请求再检查 Session。
- 在所有 Session 路由上精确匹配路径中的 ID。二进制排序规则同样会忽略 Session ID 的尾部空格，此时会找到同一个 Session；Spring 在绑定每个路径段之前会去掉 `;` 路径参数，因此 `turn_x;v=1` 读到的是 `turn_x`。不会泄露任何信息，因为租户与读权限都在找到的 Session 上检查，响应中给出的也是真实 ID。
