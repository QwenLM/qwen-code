# 工作区会话目录批量读取

[English](daemon-batch-session-catalog.md) | [简体中文](daemon-batch-session-catalog.zh-CN.md)

状态：为 [#12249](https://github.com/QwenLM/qwen-code/issues/12249) 随本文档一同实现的设计。

## 问题与范围

同时展示多个工作区的客户端，目前必须分别刷新各工作区的会话分页和分组目录。本变更新增一个只读 daemon 请求和一个 TypeScript SDK 方法。保持单工作区接口及其默认值、执行、注册和实时状态传递不变。Web Shell 迁移和全局排序的信息流不在本次范围内。

## 归属与失败语义

每个条目按现有[加固基线](daemon-multi-workspace-hardening.md)归类为 **persisted-workspace（持久化工作区）**。批次是各自独立解析的条目的有序集合，不新增归属类别。认证和 HTTP 准入仍属于进程全局。每个条目仅使用所解析 runtime 的 bridge、运行时存储目录和分组服务；任何条目都不得回退至 primary。浏览目录不执行环境覆盖或工作区服务。

`all` 枚举公开的已注册条目，包括暂时不可用的条目，但排除内部 Conversations 和已移除的工作区。显式选择器使用现有注册工作区解析规则，先匹配工作区 ID，再匹配规范化绝对路径。内部选择器按未知工作区拒绝。这避免调用可能启动 Conversations 的解析器。

| 条目状态                                              | 结果                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| 未知、内部或已移除                                    | `404 workspace_not_found`                                        |
| draining、transitioning、blocked 或 generation 已关闭 | `503 workspace_runtime_unavailable`                              |
| 不可信 primary                                        | `403 untrusted_workspace`                                        |
| 不可信 secondary                                      | 仅持久化读取，不合并实时数据、不写入修复状态、不记录调试会话日志 |
| 无效游标或分组                                        | 现有目录错误码和状态                                             |
| 读取失败                                              | `500 session_catalog_failed`                                     |
| 序列化条目超限                                        | `413 catalog_response_too_large`                                 |

读取完成后再次检查所选 runtime generation。发生替换或移除的 generation 不得返回成功页面。普通可信 runtime 可以通过现有列表方法合并 bridge 中已有的状态；枚举不得创建会话或启动 ACP 子进程。daemon 启动和关闭行为保持不变；处于 draining 或 transitioning 的工作区 generation 返回上表所列错误。

## API 与 SDK

公布 `session_catalog_batch` 能力。`POST /sessions/catalog` 接受：

- `workspaces`：`"all"` 或有序的 `{ workspace, cursor? }` 选择器数组。
- `options`：共享的 `size`、`archiveState`、`view`、`group`、`parentSessionId`、`sourceType` 和 `sourceId`，保持现有目录参数组合语义。
- `includeGroups`：可选布尔值，默认 false。

按选择顺序返回 `{ workspaces: [...] }`。成功条目包含 `workspace`（原始选择器）、规范化 `cwd`、`workspaceId`、`sessions`，以及现有的可选 `nextCursor`、`truncated`、`liveMergeFailed` 字段。请求分组时，`groups` 为完整的现有分组目录，包含颜色选项。组织视图的会话页面和所请求的分组目录使用同一份组织快照。分组 ID 由外层工作区限定。错误条目包含 `workspace`、可解析时的工作区身份和 `error: { code, message, status }`，不得伪装为成功的空页面。有效批次即使含失败条目也返回 HTTP 200。格式错误的请求在读取存储前返回 HTTP 400。

每个会话的 `workspaceCwd` 也会规范化为此所属工作区。存储规范化沿用现有单工作区行为：损坏的组织存储会记录警告并返回空分组目录，不写入修复状态。批量接口隔离已抛出的读取错误，不增加存储完整性验证，也不改变该恢复策略。

继续分页时，为每个返回的 `cwd` 和 `nextCursor` 发送显式条目。游标保持不透明并沿用现有过滤语义；客户端必须复用相同过滤条件。批量接口默认复用现有合并后按活动时间分页的方法，使用空的元数据过滤条件，让仅存在于实时状态的条目也遵守分页大小。其游标不可与旧数字游标互换。SDK 的 `listSessionsCatalog` 暴露相同结构，将现有 `pageSize` 参数映射为协议中的 `size`。客户端一次性发现能力，并为旧 daemon 使用工作区限定接口回退；目录刷新本身只发送一个 HTTP 请求。SDK 的可选第二参数接受 `signal` 和 `timeoutMs`；这些传输选项不会写入 JSON 请求体。

## 上限与实现

接受 1–20 个条目，每个条目 1–100 个会话（默认 20），最多四个条目并发读取，选择器最多 4096 字符，游标最多 16384 字符。`all` 超过 20 个工作区时显式失败，调用者可以拆分显式选择；不得静默截断工作区。每个成功条目的序列化大小限制为 512 KiB，使响应上限约为 10 MiB 加少量封装和错误开销。超限条目显式失败，调用者可缩小分页或省略分组。请求体沿用现有 daemon JSON 解析器上限。客户端断连会中止待完成的会话读取，并阻止启动后续条目。继续使用现有持久化扫描和缓存上限。

分组和父会话过滤条件最多 256 字符。只读 POST 使用现有读取限流层级，记录请求监控数据时不将整个批次归属到 primary。每个条目读取拥有带有所选工作区哈希的独立子 span，保留逐条目的扫描和缓存属性。请求 span 记录条目数，以及返回页面是否有任一被截断。

新增独立路由模块，复用现有会话列表和分组服务，仅从 HTTP 包装中提取纯工作区选择器解析逻辑。接入 daemon，添加能力、SDK 导出、协议与参考文档以及针对性测试。不需要重设计核心存储或修改客户端轮询。

## 验证与验收

在 primary 和两个 secondary 工作区下，一个请求返回归属独立的页面和可选分组目录。测试子集隔离、来源/归档/组织过滤、分页、缺失和移除的条目、generation 替换、信任行为、内部排除、无效请求、并发、大小上限及断连取消。验证现有工作区限定路由解析测试继续通过。SDK 测试覆盖序列化、响应与错误保留以及单 HTTP 请求。运行构建、类型检查、针对性测试，先使用全局 CLI 确认基线，再通过本地 bundle 做 E2E 验证。审查完整差异，保持中英文文档同步。

## 开放问题

请维护者在本 PR 中审查公共 API、上限和内部工作区排除规则。这些是满足本次不启动 ACP 的目录契约所作的明确实现选择；未来若改变内部可见性，需要另行制定不启动 runtime 的持久化读取策略。
