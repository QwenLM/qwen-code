# Managed Web UI 界面决策、对照矩阵修正与本地终端

[English](2026-11-19-managed-web-ui-parity.md) | [简体中文](2026-11-19-managed-web-ui-parity.zh-CN.md)

- 状态：已于 2026-11-20（UTC）随 [#17795](https://github.com/QwenLM/qwen-code/pull/17795) 合入，squash 提交为 [`2ebaac20284be8dbc3aff308bfc3867481f0b2d2`](https://github.com/QwenLM/qwen-code/commit/2ebaac20284be8dbc3aff308bfc3867481f0b2d2)；Issue #17717 已关闭。
- 交付验证：见[真实浏览器及选定 MySQL/Spring 验收账本](https://github.com/QwenLM/qwen-code/pull/17795#issuecomment-7027767699)。在[首次审批后的完整运行 44680245797](https://github.com/QwenLM/qwen-code/actions/runs/44680245797) 中，原生 Windows/Java 21 作业及其 `Run Runtime Broker state tests` 步骤均已通过。其它 full profile 和 main 工作流另行监视；本条状态不将它们视为已完成。
- 基线：`3f7b6088d9`（`origin/main`）；已按此修订重新核对 Issue 中的声明
- 上级跟踪单：#15084；现有归属包括 #13396 与 #16546。三者仍保持开放并覆盖 Table A 后续工作；本次状态更新不新建延期评审 Issue。

## 问题与现状

Managed Web Shell 没有解释许多 daemon 专属界面。它们的控件被隐藏，用户无法区分「正在跟踪的缺口」与「永久产品边界」。能力矩阵也有漂移：BTW 与 recap 已有挂载路由却仍标为缺失；Session worktree 各行笼统写着 `no Managed worktrees`；归档会话可经共享路由导出却仍标为缺失。

独立 Managed Web gateway 已能中继终端 WebSocket upgrade，但本地 `qwen serve --managed` 没有启用终端部署选项，也没有分发该 upgrade。Java 终端实现、一次性票、Runtime relay 与 Managed 终端面板已经存在。

当前基线的四个 Session worktree 标签均已存在。Managed 自有 Session worktree 支持创建时绑定、inspect 与 cleanup，但没有 daemon 的所有权转移 reset、创建后建分支或携带工作的 handoff 操作。近期能力也细化了 Table A 的两项声明：工作区产物库已支持跨会话游标分页，但渐进流仍缺失；符合条件的会话已接受内联文本／图片附件，但仍不提供 daemon 附件引用、分片上传或列表。

## 目标

1. 为 Table A 的每组界面提供可见的 Managed 状态、面向用户的解释和明确跟踪归属。
2. 只在当前代码能提供证据时修正 Table B，并用测试固定这些声明。
3. 让终端通过本地 `qwen serve --managed` 工作，不增加第二个 WebSocket upgrade listener，也不削弱既有 daemon 鉴权。

## 拟议改动

### Managed 界面决策

在 `ManagedSessionsPage` 增加一个 **Managed capabilities** 弹窗。无论新建还是已有会话，也无论完整 Web Shell 还是 Managed-only gateway，都可找到入口。弹窗包含 Table A 的五个分类和 #17717 的全部 35 组界面。

每一项以英文和简体中文说明当前 Managed 差异，并链接归属：

- Memory 使用 #13396。
- Agents、扩展管理、Hooks、Channels 与定时任务使用 #16546。
- 其余 29 组使用 #15084，包括轮内「立即发送」。后者会说明排队引导会在安全模型边界自动消费，同时继续跟踪是否需要独立操作入口。

所有行都标为 **tracked**，不是永久排除声明。维护者以后可通过单独评审把一行改为已交付或有意缺失。清单是客户端静态数据：它不会发送 daemon 请求、创建会话，也不会从技术 parity 标签推导产品决定。

### 能力对照修正

- 将 `session_btw`、`session_btw_stream` 与 `session_recap` 改为 `managed`，引用 `surface:SIDE_QUERY_CREATE` 或 `surface:SIDE_QUERY_STREAM`。从 `MANAGED_ONLY_REPORTED` 删除这两个新引用的标签。
- `managed` 表示已挂载路由的归属，不表示完整集成验收已通过。BTW 与 recap 的完整集成验收仍待完成；保留[既有 BTW 与 recap 设计](2026-11-09-managed-btw-recap.zh-CN.md)及其交付与验证边界，不把矩阵中的这些行当作已完成验收的证据。
- `session_worktree_persistence_v1` 保持 absent：持久化 Managed Session worktree 不等于 daemon 的逐响应 `persisted-v1` 见证合同。文案解释这一区别。
- `session_worktree_reset_v1` 保持 absent，并解释 cleanup 不是 daemon 的 reset／所有权转移操作。
- `session_worktree_branch_v1` 保持 absent：创建时分配初始分支不等于创建后的「在此建分支」操作。
- `session_worktree_handoff_v1` 保持 absent：恢复草稿交接不会在 worktree 与本地 checkout 之间搬移会话及其工作。
- `workspace_git_worktrees` 保持 absent，说明仓库级 Git worktree 管理与 Managed 自有 Session worktree 的范围差异。
- 将 `workspace_archived_session_export` 改为 `managed`，证据为 `surface:ITEM_LIST`；既有导出路由可授权读取归档会话，不需要单独的归档路由。增加归档导出行为测试。

测试逐行固定修正后的 standing 与证据 token。特别要防止把持久化工作树误判为 `persisted-v1` 见证。

### 本地终端接线

在本地启动器的 `SPRING_APPLICATION_JSON` 中同时设置 `qwen.managed-agent.runtime-broker.tool-measurements=true` 与 `qwen.managed-agent.runtime-broker.web-terminal=true`。Java 全局默认仍关闭，两个选项必须成对启用，因为带终端能力的 Worker 要求 measurements。

把独立 gateway 的原始终端 relay 移到 `managed-local-web.ts`，供两种形态复用。由 `server.ts` 向现有唯一 ACP upgrade 分发器注入 Managed 终端 upgrade 路由。该路由：

- 只对原始、未规范化路径 `/api/agent/web-shell/v1/sessions/{sessionId}/terminal` 做精确匹配，并拒绝仅由 `.` 或 `..` 组成的 session selector；
- 只允许 primary listener，并经过现有 Host 与 Origin 检查；在认证场景的非 loopback bind 上，仍执行 loopback Host 白名单；
- 在 daemon bearer 校验前接管，因为 `qwen-bearer.<ticket>` 属于 Java 一次性终端票协议，不是 daemon token；
- 只转发 WebSocket 握手头、query 与初始字节，绝不转发浏览器 `Authorization`、Cookie、签名或身份头；
- 只返回安全的 `qwen-ws` 子协议，其他 upgrade 路径保持不变。

终端依赖此分发器，因此 Managed 本地启动遇到 `QWEN_SERVE_ACP_HTTP=0` 会明确拒绝，而不是通告不可达的终端。普通 daemon 继续保留既有 ACP 关闭行为。

当前 Runtime resolver 已在同一 local-mount profile 上兼容 ordinary、measured 与 terminal digest，并根据会话自己的 READY、未 drain 终端 binding 计算摘要提示。直接复用这些门禁，不修改 Java Runtime 代码。relay 仍执行完整准入；摘要中的 capability 仍是 UI 提示，不是授权判断。

### 文档

更新现有 Managed 终端设计双语文档与本地 Managed 用户指南双语文档，写明已实现的本地入口、一次性票与本地 shell 风险。本地终端允许获授权操作者不经过逐命令模型审批、以服务器 OS 账户运行任意命令；它不是新模型工具或权限模式。

## 设计决策与理由

- **使用一个清单弹窗，而不是散落的禁用控件。** 它能一致覆盖隐藏界面，不复制 35 个控件，也不引入通用 capability 框架。
- **跟踪不等于产品排除。** 尚未决定的界面继续明确归属 #15084，直到维护者作出决定。
- **复用 gateway relay 与 ACP 分发器。** 第二个 HTTP `upgrade` listener 会与 ACP listener 竞争，而后者会销毁未知路径。
- **ticket 鉴权与 daemon 鉴权分离。** 既有 HTTP ticket 请求先经 daemon 鉴权并由本地代理签名；Java 在 upgrade 时消费该票。
- **不新增终端协议或 API 形状。** 既有 ticket DTO、Runtime 准入、面板与 relay 仍是权威边界。

## 范围边界

- 不实现 35 组 daemon 界面本身。
- 除每项解释中已记载的现实差异外，不新增永久产品排除。
- 不新增 parity 标签、OpenAPI 路由、模型工具、模型动作审批绕过、终端日志或 artifact。
- 不支持 SSH、resident、extension 或仓库级 worktree。
- 不改变普通 daemon `/acp`、`/terminal`、Voice 或 CDP upgrade 行为。

## 涉及文件

- Managed UI：`ManagedSessionsPage.tsx`、聚焦的界面决策清单／弹窗及同目录测试。
- Parity：`packages/cli/src/serve/capability-parity.ts` 及其测试；`ManagedAgentApiContractTest` 的归档导出覆盖。
- 本地终端：`managed-local-serve.ts`、`managed-local-web.ts`、`managed-web-serve.ts`、`server.ts`、`acp-http/index.ts` 与聚焦测试。
- 文档：现有终端设计与本地 Managed 用户指南双语文档，以及本设计和 E2E 计划。

## 验证计划

1. 运行聚焦 CLI parity、本地启动器、原始 relay、gateway 与真实前门 upgrade 测试。
2. 运行 Managed 弹窗与 Sessions 页面测试，覆盖全部 35 组、链接、全部语言变体且不产生额外后端调用。
3. 按模块十分钟本地预算，使用 JDK 21 运行聚焦 Java 归档导出、scope 兼容与终端准入测试及 Checkstyle。
4. 构建、类型检查并打包 TypeScript workspace。
5. 通过 `dist/cli.js` 验证本地 Managed 终端：capability、ticket、101 upgrade、命令回显、resize／replay、一次性票拒绝、Host／Origin 拒绝以及其他 upgrade 路由不回归。
6. 在浏览器打开 Managed capabilities 弹窗，确认分类与链接，并确认打开时没有新增 API 请求。

## 验收标准与待决问题

当上述目标均有聚焦回归覆盖、且本地前门完成真实终端 upgrade 时，实现完成。完整 Java 套件、MySQL profile 与 CI 仍是各自适用的独立必需门禁。

未决维护者决定继续由 #15084 跟踪：每项界面究竟应实现、永久排除还是改派到更具体的 Issue。本改动不会把未决项包装成已解决的产品决定。
