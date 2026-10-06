# Hosted Action 输入预览：Java 先行上线

[English](2026-10-04-hosted-action-input-preview.md) | [简体中文](2026-10-04-hosted-action-input-preview.zh-CN.md)

## 问题与范围

#13160 是 #13271 公开前台 Shell 准入的门禁：审批者必须能查看工具输入。Harness 已发布 `managed-tool-input`，但只有审批 checkpoint 引用了它。Java 从字段集合封闭的版本 1 `managed-action-options` 资源投影 Action，而 transcript Items 刻意不包含参数。

这是上线的第一步：让 Java 接受版本 2 options，并在两个 Action API 入口提供有界输入预览。Harness 仍写版本 1，WebShell 审批卡仍沿用当前 transcript 回退。读取端部署后，后续改动才写版本 2 并使用预览。写入端必须把被引用的输入加入第一笔 Action 提交：目前 HTTP 资源闭包只跟随 checkpoint 和扩展记录，不跟随 Action options，且 Action 先于 checkpoint 提交。本步骤不关闭这两个 issue，公开 Shell 继续禁用。

## 契约与兼容性

版本 1 options 保持原有精确字段集合。版本 2 新增一个 `inputRef` 字段，指向该调用已发布的 `managed-tool-input` 资源。其余字段、审批策略和决定字节都不变。`action.changed` envelope 不变；引用位于其不透明 options 资源中。未知版本和额外 options 字段仍被拒绝。Journal 写入时，对照同一 Session 已提交的资源验证引用的封闭字段集合、kind、schema version、长度和 digest。Workspace 恢复会递归追踪 Action options 中的引用，因此必须在悬空引用进入 authority journal 之前拒绝它。存储的 options JSON 已能保存这个引用，因此无需数据库迁移。

先部署 Java 读取端，再启用版本 2 写入端。旧 Java 会拒绝版本 2，从而拒绝该审批的整笔 journal 事务。目前没有协商 options 版本的能力；本步骤不新增开关或协商协议。版本 1 写入端及历史版本 1 Action 仍可读取和作答。

## 预览与信任边界

公开 permission Action 新增可选 `input_preview`，含 `text`、`truncated` 和 `byte_length`；WebShell 对应字段为 `inputPreview`，含 `text`、`truncated` 和 `byteLength`。预览文本是工具输入包装体中保存的原始 `payloadJson` 字符串，包含发送给 Broker 的 `{toolName,input}`。Java 不重新序列化它，保留键顺序、转义和数字写法。完整字节长度按该字符串的 UTF-8 字节计算。文本为最多 8192 字节的前缀，在不完整的 UTF-8 码点之前结束；截断后不保证仍是有效 JSON。

仅处于 requested 状态的原生 `read_file`、`write_file`、`edit` 和 `run_shell_command` Action 提供预览。MCP 输入包含内部 grant 与身份信息，本步骤保留其不可用状态，避免公开这些凭据。未知工具类型也不提供预览。这不是通用秘密脱敏：原生写入内容和 Shell 命令文本仍会在字节上限内展示给已有 Session 读取权限的 actor。

四个列表和详情路由都在投影前保留 `requireReadableSession`。复用已提交 inline 资源读取端，验证租户及 Session 范围、referenced 状态、引用元数据、存储长度和 SHA-256。每个 Session 只有一个不可变的 journal Workspace 范围，引用不能选择其他 Session 或租户。校验种类 `managed-tool-input`、schema 版本 1、严格 UTF-8/JSON、包装体的 Session 身份和字段集合，以及 payload 工具名与 Action 是否匹配。输入缺失、损坏、格式错误或不匹配时不返回预览，且不让 Action 读取失败。审批选项、仅创建者可作答的规则以及 transcript 投影均保持不变。

Harness 写入端提供审批与已捕获调用之间的不可变绑定。Java 验证被引用资源、Session 和工具，不从私有 checkpoint 或不含参数的 Items 重建该绑定。后续写入端必须在 Action 与 checkpoint 中复用同一个已捕获输入引用，并测试同一工具的不同调用，保证不会混用输入。

## 改动与验证

扩展 Java options 读取端、共享 Action 投影和已有的已提交资源读取端。在 OpenAPI 增加可选预览 schema，重新生成 WebShell 类型。同步更新 D6 Actions 设计的中英文版本，记录本次上线步骤。

回归测试通过 Session store 提交真实版本 2 Action journal 与工具输入资源，然后读取公开及 WebShell 列表、详情路由。验证小输入精确相等、恰好 8192 字节、8193 个 ASCII 字节，以及在多字节边界附近结束的大输入。写入时拒绝格式错误、悬空、元数据不匹配和跨 Session/租户的引用，再损坏已存储的引用或资源，验证读取仍会省略不可用的预览。还需覆盖格式错误的 payload、不支持的 MCP 输入及版本 1 兼容性。已有 allow/deny、终态结算和访问控制测试必须保持通过。版本 2 回归在旧 Java 读取端应于返回任何预览之前失败。

API 响应证据是这一步读取端的可观察结果。浏览器预览渲染、真实 Harness 写版本 2、重启结果和公开 Shell 启用属于后续阶段；本步骤不得声称已验证它们。

## 验收与后续

- 带有效版本 2 options 的 requested 原生工具 Action 在公开与 WebShell 列表、详情 API 提供一致的有界预览。
- 输入不可用不会让 Action 无法读取；未知 options 版本、字段集合变化和无效输入引用仍在写入时严格拒绝。
- 版本 1 Action 继续按已有策略读取和作答。
- 生成类型与契约一致；两种语言描述相同的上限与上线顺序。
- Java 读取端部署后，接续 Harness 写版本 2 与 WebShell 审批卡，再重新核对 #13271 剩余的审批、崩溃和启用门禁。
