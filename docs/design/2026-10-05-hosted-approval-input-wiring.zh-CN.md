# Hosted 审批输入：Harness 与卡片接线

[English](2026-10-05-hosted-approval-input-wiring.md) | [简体中文](2026-10-05-hosted-approval-input-wiring.zh-CN.md)

## 问题与范围

#13160 要求审批者能看到被批准的确切调用输入。#13400 的 Java 读取端已接受版本 2 Action options 并返回有界预览，但 Harness 仍写版本 1，managed WebShell provider 也未保留预览。本改动完成写入端与卡片链路，依赖先部署 [Java 读取端](2026-10-04-hosted-action-input-preview.zh-CN.md)，不会开启 #13271 的公开 Shell 准入。

## Harness 与资源提交

保持版本 1 options 不变。版本 2 新增必需的 `inputRef`，沿用已有持久引用元数据和资源 schema 版本 1。仅为 `read_file`、`write_file`、`edit`、`run_shell_command` 写版本 2，与 Java 读取端一致。MCP 和不支持的工具保持版本 1，不暴露内部 grant。Action envelope、审批策略、决定字节和 digest 保持不变。

使用当前 `ask` 调用收到的已捕获引用。同一引用已写入当前 checkpoint 的 `approval.invocationRef`，并用于获批原生调用。不得重建输入、按工具名查找，或使用 `attempt.routeRef`：后续审批可能保留前一次 attempt，但调用输入已变化。PreToolUse 改写参数时，现有重新捕获与审批路径必须将新引用写入新 Action，并保留先前 Action 的引用。

第一笔 Action 提交早于其 await-action checkpoint。发布资源只会暂存字节，因此等 checkpoint 遍历再上传输入，无法通过 Java 的写入守卫。扩展 HTTP store 的现有资源闭包，跟随暂存 `managed-action-options` 内的引用，复用引用收集、元数据相等检查和去重。输入随第一笔 Action 提交上传，不上传无关暂存资源。无需新增 store API，也不让 core 依赖 CLI。

## WebShell 展示

将 API 的可选 `inputPreview` 传过 managed provider。匹配调用的 transcript 参数仍优先显示；参数缺失时，将原始预览文本作为 text content block，并设置 `contentIsInput`，不设置 `rawInput`。截断文本可能不是有效 JSON，不得解析、trim 或重新格式化。

共享审批卡已通过 React `<pre>` 逐字展示该内容，包括 Shell payload，无需修改。managed 页面将参数不可见提示替换为本地化的完整字节数提示，并在需要时说明截断。复用已有 accessible description ID，将提示关联到当前审批 dialog。两种输入来源都缺失时，保留原有不可见提示。不把预览复制到 transcript 工具行，也不按工具名匹配调用。

## 影响文件

| 层                         | 文件                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| options 与当前调用绑定     | `packages/cli/src/serve/hosted-tool-approval.ts`、`hosted-workspace-tool-turn.ts`                                                 |
| 第一笔提交的资源闭包       | `packages/core/src/managed-runtime/http-managed-session-store.ts`                                                                 |
| managed API 映射与权限内容 | `packages/web-shell/client/components/managed/managed-agent-provider.ts`、`java-managed-agent-provider.ts`、`managed-approval.ts` |
| 提示与翻译                 | `packages/web-shell/client/components/managed/ManagedSessionsPage.tsx`、`packages/web-shell/client/i18n.tsx`                      |

扩充这些路径的现有集中测试。Java、生成的 API 类型、共享审批渲染、Harness authority 与 factory 行为保持不变。

## 兼容性与限制

先部署 Java 读取端，再部署新 Harness 写入端；旧 Java 会拒绝版本 2 事务。不新增协商或部署开关。早于本次提交的 CLI 检查器无法校验之后写入的快照：已捕获的输入在 Action 事务中提交，并被 await-action checkpoint 的闭包再次列出，因此带有两个被引用 revision；没有 options→input 边的检查器只能通过 checkpoint 到达它，进而在 revision 集合校验上失败。此时 `managed-csi-checkpoint-evidence` 会在曾发起原生审批的 Session 上以 `Managed Session Store: snapshot resource reference revisions conflict.` 退出码 1，尽管数据并没有损坏。本构建的读取端没有问题；回滚或滚动发布期间的混合机群不行，与 `2026-09-30-hosted-turn-failover-e2e.md` 记录的 journal 变更同类。历史版本 1 Action 仍可用，预览字段仍可选，公开 Shell 保持关闭。读取端的 8192 字节 UTF-8 上限，以及已有 Session 读取与创建者作答权限保持不变。不增加秘密脱敏、MCP 预览、重启恢复或 Shell 接管。

## 验证与验收

先完成生产接线，再补最小回归集并执行一次集中验证。在最后一轮中比较基线和本地实现，不在编码期间启动运行环境。

- 验证同一原生工具的两次调用有独立的 request ID、function-call ID 和输入引用；每个 options 引用等于当前审批 invocation 引用，且只包含对应调用的参数。
- 验证参数改写产生新 Action/ref，MCP 仍为版本 1。
- 验证首次 Action HTTP 提交在任何 checkpoint 之前已含 options 和引用的输入，且不含无关暂存输入。
- 验证 provider 保留字段、transcript 优先级、截断原文、不可见回退、完整/截断字节提示及已挂载的 accessible description。
- 运行受控模型服务下的原生审批链路：卡片显示每次调用输入，允许后第一次调用只执行一次，拒绝后第二次不执行。保留实际文件效果、HTTP 数据、tmux 捕获及最后的浏览器截图，说明模型与夹具边界。
- 最后一轮通过后，完成 #13160 的写入端与卡片验收缺口；#13271 仍需独立的准入、崩溃与启用门禁。本改动不启用公开 Shell。
