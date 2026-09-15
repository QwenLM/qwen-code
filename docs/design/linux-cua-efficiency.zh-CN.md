# Linux CUA 发现与观察修复

[English](linux-cua-efficiency.md) | [简体中文](linux-cua-efficiency.zh-CN.md)

## 问题与范围

Linux 评测轨迹出现刚签发的元素 token 立即失效、有上限的无障碍树反复抓取、
应用发现混入大量进程，以及错误诊断信息丢失。本次修复 9 月 14 日调查的 1–5 项，
并纳入配套的 Computer Use skill 图片转发指引（第 6 项）。状态：本仓库修复和转发示例
已验证；第 2 项仍需修改外部 OSWorld 启动配置。

## 决策

- 保留 AT-SPI 的应用级索引。Linux 缓存以真实索引为键，快照 token 校验索引成员关系，
  拒绝空洞。其他平台保留连续索引注册方式。替换窗口快照会使该窗口旧 token 失效。
- X11 发现失败返回 `desktop_unavailable` 和 MCP 环境配置提示。保留现有 Wayland
  回退策略。MCP 宿主必须在启动时传入真实桌面环境；REPL 不猜测显示编号、认证文件
  或其他用户的会话。OSWorld 配置生成器在本仓库之外，仍需更新其环境变量白名单。
- 仅因 `max_elements_reached` 或 `max_depth_reached` 停止的抓取，在已覆盖范围内
  读取完整。返回 `capture_read_complete`，保留有上限的观察版本链，避免 SDK 重试。
  读取错误、超时、窗口范围不明确和缺少身份仍使版本链失效。有上限与完整抓取使用
  独立版本链，覆盖范围切换时互相失效。SDK 也识别旧驱动的 Linux 上限原因字符串。
  有上限抓取未变化时返回 `no_change`；有变化时按共享版本策略返回包含稳定 ID 的完整局部视图。
- Linux 运行中应用指拥有顶层窗口的进程，包含最小化窗口。返回窗口，合并启动器元数据，
  并保留已安装启动器。`running_only` 排除仅安装的条目。`active` 仍为保留字段且为 false。
  因此，无窗口后台应用不再被报告为运行中。
- 通过 REPL 协议及 MCP 输出保留异常 `code` 和有长度限制的 `details` 文本。
  code 限制为 256 字符，details 限制为 4096 字符，允许附加截断提示。
  禁用自定义 inspector 和 getter，允许循环引用。保留现有输出 token 上限和执行状态。
- Computer Use skill 通过外层 code-mode 的 `text()` 和 `image()` 分别转发单个 MCP
  文本块和图片块，包含 `node_repl_wait` 延迟返回的结果。文档示例因此不会把图片 base64
  序列化到文本中。SDK 打包时复制同一份规范 skill。

## 验证与验收

回归测试覆盖不连续索引及空洞、单窗口替换、有上限观察的 no-change/稳定完整视图、
切换完整覆盖、读取失败、GUI 进程过滤及启动器元数据、`running_only`，以及输出预算内的
错误恢复信息。

2026 年 9 月 14 日完成验证：

- Linux：26 项核心元素 token 测试、273 项平台测试通过，4 项平台测试仍为忽略状态。
  原生编译通过。
- JavaScript：57 项 SDK 测试、83 项 Node REPL 测试通过。独立抓取、环境继承、
  已构建 MCP 及 CLI 到 MCP 的检查通过。
- skill 转发示例基于真实 MCP 响应的 8 项检查通过，包含延迟图片和错误。这验证了示例
  的执行行为；未测量模型遵循情况及 Codex UI 渲染效果。
- Xvfb 中的真实 GTK 应用提供两个窗口，第二个窗口暴露稀疏索引 30–35。
  直接动作和注册表签发的快照 token 均准确触发首尾按钮。应用发现返回拥有窗口的进程
  及其两个窗口。元素数和深度上限均保留 `capture_read_complete`；缺少桌面环境时，
  两个发现工具均返回 `desktop_unavailable`。
- 仓库 build、typecheck 和 bundle 通过。生产代码差异自审及独立审查未发现可操作缺陷。

两组评测尚未重跑，benchmark token 降幅尚未测量。

## 待解决依赖

仍需可访问的 Agent-Hub `osworld-v2` 模板 checkout。其 Codex MCP 配置必须在 node-repl
启动前转发桌面会话变量；本仓库 SDK 修改可以明确报告配置错误，但不能还原被父进程
移除的变量。完成此项需要定位对应模板、更新环境变量白名单，并从该启动器验证桌面发现。
