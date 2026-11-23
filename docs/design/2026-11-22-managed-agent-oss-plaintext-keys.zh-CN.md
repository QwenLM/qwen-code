# managed-agent OSS 对象键使用明文身份路径段

[English](2026-11-22-managed-agent-oss-plaintext-keys.md) | [简体中文](2026-11-22-managed-agent-oss-plaintext-keys.zh-CN.md)

状态：已实现（2026-11-22）。OSS 外置功能尚未发布，因此不需要兼容旧的哈希键布局。

## 问题

managed-agent 服务器将三类字节外置到私有阿里云 OSS bucket：超尺寸会话资源、压缩后的 journal pack、以及工具发布产物。三者都用会话身份的 SHA-256 哈希（即 SQL 索引键 `scope_key` 的同一值）作为对象路径段。哈希使 OSS 对象不可读：运维在 bucket 控制台浏览时，无法直接看出对象属于哪个租户、工作区或会话，必须先查 SQL 把身份映射成哈希。调试和存储审计对每个对象都要多做一次查询。

## 方案

只把每个 OSS 键中的哈希 scope 段替换为明文身份段。SQL 的 `scope_key` 哈希及由它派生的所有 SQL 身份键保持不变；OSS 读取始终解析行中存储的精确 `object_key` 列，因此键构造与 SQL 身份解耦。

新布局：

- 会话资源：`{ossKeyPrefix}{tenantId}/{sessionId}/{resourceId}/{uuid}`（默认前缀 `session-resources/`）。
- Journal pack：`{ossKeyPrefix}packs/{tenantId}/{sessionId}/{packId}`，其中 `packId` 为 `pack-` 加 UUID。
- 工具发布产物：`managed-tool-results/{tenantId}/{workspaceId}/{sessionId}/{publicationId}/{slot}`。slot 原样使用（`admission`、`terminal`、`segment:stdout:0`、`page:stderr:12`、`manifest:1`、`content:<id>`）；此前 slot 是被哈希的。

发布布局包含 `workspaceId`，因为它的 scope 哈希是（租户、工作区、会话）三元组，而另外两者只按（租户、会话）划分。

## 设计决策

1. **SQL 身份保持哈希。** `scope_key CHAR(64)` 是发布目录各表的索引和唯一键组成部分，资源身份键是 (scope, resourceId) 的哈希。改动它们是一次没有可运维性收益的 schema 迁移；只有 OSS 路径需要变得可读。
2. **不做兼容层。** 功能尚未上线，任何部署中都不存在哈希布局的对象。重放路径用同一组已校验输入确定性地重算键，因此重算键恒等于已存储键；已写对象的读取无论如何都使用存储键。
3. **路径安全依赖既有边界校验，不新增编码。** 租户身份由租户头过滤器按 `[A-Za-z0-9._:-]{1,128}` 准入；工作区选择准入 `[A-Za-z0-9._:-]{1,128}`；会话身份是服务端生成的 UUID（relay 查询准入 `[A-Za-z0-9._-]{1,256}`）；发布标识为 `[a-z0-9_-]{1,128}`；slot 是固定协议字符串或匹配 `segment:`/`page:`/`content:` 正则。均不含 `/` 或控制字符，因此任何段都无需转义。
4. **资源标识保持不透明文本。** 会话资源 id 校验为不超过 512 字节、不含控制字符的非空 Unicode 文本；可以包含 `/`。这只会在控制台增加目录层级。正确性不受影响，因为分配、上传和读取都使用分配行中存储的精确键，且末尾 UUID 保证键唯一。

## 约束

OSS 键上限 1023 字节。按保守的 256 字节会话上界（真实会话是 36 字节 UUID）计算，默认前缀下的最坏长度：会话资源 ≤ 971 字节，发布产物 ≤ 901 字节，journal pack ≤ 451 字节。自定义 `ossKeyPrefix` 会占用剩余余量；超长的键会使 PUT 失败关闭（fail closed），操作保持可重试——绝不会被静默截断。

## 风险

- 租户、工作区和会话身份会出现在 OSS 访问日志和控制台中。可接受：bucket 私有且仅运维可见，这些身份在 SQL 中本就可见。
- 同一租户的对象共享键前缀，OSS 前缀分区比哈希 scope 更粗。可接受：单租户会话负载有界，且可读性正是本次改动的目标。

## 验证与验收

- 聚焦单元测试断言会话资源和 journal pack 的新明文前缀，并对外置字节做往返读取；发布套件在新键上覆盖上传、校验、finish 和重放路径。
- 改动的生产模块通过 Checkstyle。
- 验收：模块完整 CI 门禁在 PR 修订上通过。本地验证覆盖上述聚焦回归；完整套件在 CI 运行。

## 开放问题

无。
