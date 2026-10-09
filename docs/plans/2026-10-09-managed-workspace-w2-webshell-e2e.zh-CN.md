# W2 WebShell 行为 E2E 计划

[English](2026-10-09-managed-workspace-w2-webshell-e2e.md) | [简体中文](2026-10-09-managed-workspace-w2-webshell-e2e.zh-CN.md)

## 基线与测试分层

全局 `qwen --version` 和 `qwen serve --help` 用于识别已安装 Runtime，不能证明 Java WebShell 行为。变更前，绑定 Session 没有 cwd 控件。从 `packages/web-shell` 运行聚焦测试。浏览器接口模拟、真实 Java/Hosted 执行与真实模型规则采用分别记录证据。

## 浏览器行为

在独立 Vite 端口使用包含身份范围的 Java provider fixture `packages/web-shell/client/e2e/fixtures/managed-workspace-w0d.html`。浏览器测试可拦截 BFF 接口，控制响应丢失、operation 状态与响应顺序。保存切换前、中、后的截图，检查 scoped portal 主题、键盘焦点与状态播报。

1. 缺少 cwdChange、缺少身份范围或使用 Daemon：没有新入口。Provider 支持、能力为 true 且 revision 有效时，在当前目录旁打开弹窗，默认显示当前值并解释 Workspace 根目录与 `.`。
2. A→B，再切到 `.` 与包含首尾空格的中文路径。断言提交字符串原样保留；空值与相同值不能提交。使用 Enter 提交。完成并读回权威 revision 前，A 仍为当前目录。草稿可编辑，发送与再次切换禁用，关闭弹窗后操作仍可见。历史、已加载分页与草稿保留，不重新获取 transcript 或生成聊天消息。
3. 拒绝非法/不存在/越界/符号链接路径、不可用 Workspace、无权限调用者、执行中任务与审批。解释错误类别且不改变已提交 cwd。revision 冲突刷新当前上下文，必须由用户再次操作才生成新请求。弹窗打开期间改变 revision，提交前必须明确确认。
4. 丢失提交响应后刷新，验证不自动重放。继续确认复用原请求/键并返回原 operation。已知 operation 刷新后自动查询，包括能力撤销后。查询权限拒绝时保留待确认结果和原意图。
5. 已接纳操作实际等待 30 秒。显示结果待确认并保持发送锁；继续确认查询同一 operation。分别验证网络/查询失败与终态失败。首次 sessionStorage 保存失败时 POST 为零；后续保存失败仍须保留原语义请求/键以便恢复。
6. 竞争发送/切换、快速双提交与双标签页。单页同步 guard 仅接纳一个请求；跨页由服务端裁决。新 revision 后返回旧 summary，并将 poll/event 响应按逆 revision 顺序放入同批更新：当前 cwd 不回退。请求未完成时选择其他 Session/账号，终止旧请求并忽略迟到结果，恢复记录不跨身份。

## 真实 Java 与 Hosted 行为

运行根目录 `npm run build`、`npm run typecheck`、`npm run bundle`。使用 JDK 21 运行既有 `HostedPublicWorkspaceIT#workspaceCwdChangeSettlesThroughBothSurfaces`，指定 `-Dnode.executable=<Node 绝对路径>` 和 `-Dqwen.cli.entry=<dist/cli.js 绝对路径>`。用例启动真实 Spring/Broker/Harness/worker 进程，验证完成、重放、上下文事件/revision、根目录与路径拒绝，以及切换后写入 B 而 A 原文件保留。本地 H2/确定性模型用例不证明真实 MySQL 等价性、真实文件系统中文/符号链接场景或项目规则采用。

## 发布验收与兼容性

能返回 true 的 BFF 合入/部署前，#13564 必须通过同 Hosted attachment A→B 验收：下一轮写入 B 并采用 B 的 QWEN.md/AGENTS.md，无需重建 Session。还需验证真实文件系统中文/空格/边界与执行中/审批 admission、React 18/19 键盘/ref-sensitive 弹窗行为及 portal 主题。在此之前，前端可安全合入并对缺少能力的服务端隐藏入口。确定性模型不能作为真实规则测试的证据。

## 验证记录

本地材料与精确命令/结果放在 `.qwen/e2e-tests/`，在 PR 中单独报告。此版本浏览器十组、真实 H2 cwd 进程用例与聚焦测试通过；另有十七项 React 18.3.1 hook/控件测试在隔离单 Runtime 的 jsdom 环境通过。真实模型 #13564 门槛、MySQL 全家族与 React 18 浏览器执行仍未验证。后续运行继续记录，不能用假设替换这些限制。
