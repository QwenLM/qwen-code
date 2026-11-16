# Managed Workspace 基础工具对齐

[English](2026-11-06-managed-basic-tools.md) | [简体中文](2026-11-06-managed-basic-tools.zh-CN.md)

## 状态与范围

实现设计，2026-11-06。本次覆盖普通 Managed Workspace 文件及 Shell 会话的文件查找、持久化待办与 PDF 页码选择。不增加结构化问答、grep、LSP 或其他 daemon 能力。

## 问题与现状

内置文件会话选择 `hosted-workspace-files/1`，缺少 `glob`。普通 Shell 会话选择 `hosted-workspace-shell/1`，包含 `glob`，但没有 `todo_write`。`hosted-workspace-files/3` 已实现持久化 Session 待办。普通 Hosted 文件执行已将 `read_file.pages` 传给 Core，但模型声明没有该参数。

现有 profile 已控制生命周期、审批、Plan 模式、扩展及恢复，直接完善其工具声明即可。本次不要求兼容历史会话的工具集合或旧工具 schema。私有 CSI 执行器复用文件声明，但拒绝 `pages`。

## 目标行为

| 会话                        | Profile                    | 增加的能力          |
| --------------------------- | -------------------------- | ------------------- |
| 普通 Hosted 文件会话        | `hosted-workspace-files/1` | `glob`              |
| 普通 Hosted Shell 会话      | `hosted-workspace-shell/1` | 持久化 `todo_write` |
| Resident/CSI Workspace 会话 | 现有受限文件 profile       | 无                  |

不新增 profile 版本、默认选择逻辑、能力协商或 Java/SDK 适配。创建和加载使用同一套当前工具声明，不再选择旧工具集合。既有回执幂等性和已持久化的 Session 身份仍是正确性要求。文件搜索、带待办的文件 profile 和只读子代理保留各自现有用途。SSH 继续执行 foreground-only 限制；glob 走现有原生文件通路，待办走 Session journal。

普通文件会话有意预批准原生 `glob`，与现有搜索及 Shell profile 一致。未声明的工具在审批前拒绝。MCP 工具名称仍隔离为 `mcp_<digest>` 别名，即使服务端将工具命名为 `glob`，也继续遵守既有审批要求。

普通 Hosted 的 `read_file` 声明（包含只读子代理）开放已有可选参数 `pages`。这是对现有执行能力的增量声明，不增加工具名称。Resident/CSI 声明保持不变。Core 继续负责页码校验和提取：页码从 1 开始，支持单页与闭区间，每次最多选择 20 页。不改变结果预算。实时及恢复路径中，PDF 结果过大时都提示缩小 `pages` 范围；文本继续提示使用 `offset`/`limit`。

声明引用 Core 的页数限制常量，确保提示与执行保持一致。

恢复必须与当前工具声明完全匹配。旧 schema 保存的待恢复读取会被拒绝，不再通过移除 `pages` 回退匹配。含不兼容待处理工作的开发会话需要重新创建。

## 组件与边界

现有 Java 准入、Turn 快照、审批、Plan 和生命周期契约继续适用于 `files/1` 与 `shell/1`。glob 通过普通 profile 判断开放，不加入共享受限文件工具数组。Resident/CSI 继续只声明和执行读取、写入、编辑。不需要 Java/SDK 生产代码改动或数据库迁移。

Harness 的创建、加载、工具、审批与恢复使用同一套精确 profile 词汇。待办复用现有 Session 待办持久化、校验、投影及重放行为。Plan 模式的只读工具集合继续排除待办写入，待办也不会变成 Runtime 文件系统操作。

Workspace 恢复校验 `todo_state` 域并沿已保存的记录链读取，确保加载已分离的 Session 时能够恢复并重新注入当前待办列表。

实现涉及 `packages/cli/src/serve` 的 profile 判断、工具声明和 Session 恢复，以及聚焦单元测试和打包进程测试。复用 Core PDF 解析及既有 Java/Web Shell 待办投影。

## 验证与验收

1. 普通 `files/1` 声明和执行 `glob`；`shell/1` 声明 `todo_write`。
2. 创建和加载使用当前声明；恢复拒绝过时的读取 schema，不包含历史工具集合或 schema 回退。
3. 既有审批、Plan、生命周期、扩展和子代理继续使用当前 profile 契约。Resident/CSI 与 SSH 执行限制继续生效。
4. Shell 待办在会话重新加载后保留，沿用现有校验与事件投影。非法待办内容及缺失的历史引用会在模型调用前拒绝加载。Plan 模式不声明待办写入。
5. Hosted 声明及转发请求包含 `pages`。对真实三页 PDF 读取第 2 页，只返回该页标记。错误及超量范围由 Core 校验拒绝；普通文本行范围读取继续有效。CSI 不声明 `pages`。
6. 执行聚焦 TypeScript 测试、构建、类型检查，以及使用本地确定性模型的打包 Harness 进程测试。在 `.qwen/e2e-tests/managed-basic-tools.md` 记录基线及本地验证结果。

Java/SDK 生产代码无改动；Hosted Java fixture 的精确工具集合会同步普通声明。由于累计本地 Java 验证预算已耗尽，该 fixture 的执行待 CI 完成。完整 CI、Linux 及已部署 Hosted 验收，除非实际执行，否则属于独立证据。Fixture 成功不代表真实模型或生产验收。

## 风险与开放问题

主要风险是向受限 CSI 会话暴露普通工具，或接受过时的已保存 schema。需要分别验证声明和执行拒绝路径。本次范围内没有未决产品问题。

启用这些能力前，一并部署匹配的控制面、Harness 与 Runtime 产物。默认 `files/1` 标识现在包含 `glob`；旧 Runtime 的能力标识本身不能证明它能够执行该工具。现有标识不负责协商混合版本的工具集合。已保存声明不兼容的开发 Session 必须重建。
