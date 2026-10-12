# Managed 子 Agent 面板 E2E 计划

[English](2026-10-12-managed-child-task-panel-e2e.md) | [简体中文](2026-10-12-managed-child-task-panel-e2e.zh-CN.md)

## 基线

实现前运行全局 `qwen --version` 和 `qwen serve --help`。CLI 基线证明运行时可用，不证明浏览器功能支持。独立启动端口 18480 的 Web Shell Vite，使用已有 Managed Java Provider 浏览器 fixture。变更前即使 Java Session 声明 `tasks: true`，也没有子 Agent 任务入口。浏览器测试使用受控 BFF 制造响应丢失与竞争，不作为真实 Hosted 执行证据。

## 浏览器分组

通过 `.qwen/e2e-tests/managed-child-task-panel-browser.mjs` 运行隔离 Playwright context；临时状态和截图保存在 `.qwen/e2e-tests/`。使用已安装的 Chromium。每个 context 独立持有 Session 和 operation map。

1. 兼容：缺少任务能力及 Daemon 无入口；Java 缺少身份范围时可读取、不可取消。
2. 浏览：混合原始分页、过滤空页但有下一页、返回上一页及滚动恢复；不捏造名称或总数。查看详情、状态历史与产物缺失，验证草稿和历史保留、不重载 transcript。
3. 布局与可访问性：宽容器显示 360px 右栏且可编辑草稿；窄容器使用带主题的 portal Dialog，支持键盘和焦点恢复。
4. 取消：行内确认、一次提交、命令完成而任务仍执行、draining、任务已取消、自然完成、失败与服务端竞争。发送始终遵守原有 Session 规则。
5. 恢复：丢失 202、刷新后仅有意图、明确点击后原键重放、已知 operation ID 刷新、超时及继续确认、恢复阻塞、权限或查询失败、存储拒绝。不把未知结果显示为失败，不产生新键。
6. 隔离：切换任务、分页、Session、账号后迟到的列表、详情、事件和 operation 响应；双标签页竞争；标签页隐藏或关闭面板暂停普通读取，取消恢复继续保留。
7. 事件与产物：游标过期重置并显示历史缺失；未知类型推进游标但不展示，分页游标不替换为任务尾部；授权公开产物引用复用现有读取器。

## 真实 Java 与 Hosted

先 build 和 bundle CLI，再使用 JDK 21 和本地 `dist/cli.js` 运行现有 Java 任务读取、取消和 Hosted 子 Agent 验收。通过浏览器面板连接真实 Java 服务及 Hosted Harness，使用确定性的 OpenAI 兼容模型 fixture，启动并取消真实子任务。区分停止受理与实际任务结局，并验证父会话后续执行。确定性模型提供协议及物理执行证据，不代表真实模型质量验证。明确记录未执行场景。

## 单测与发布检查

从 `packages/web-shell` 运行受影响的 client、Provider、hook 和组件测试，并隔离运行 React 18 ref 与 Dialog 路径测试。运行根目录 build、typecheck、bundle，针对性 ESLint/Prettier 及生成类型漂移检查。完整 diff 两轮干净自审后执行独立代码审查。在唯一 draft PR 上单独发布实际 E2E 结果，如实说明 macOS、Windows 和 Linux 验证。
