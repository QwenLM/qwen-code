# Web Shell 表格全屏查看

[English](web-shell-table-fullscreen.md) | [简体中文](web-shell-table-fullscreen.zh-CN.md)

## 问题与范围

独立 Web Shell 在会话历史中使用增强 Markdown 表格。表格宽度受消息栏限制，
滚动区域高度限制为 `min(75vh, 720px)`，内容较多时不便查看。

为增强表格增加占满视口的查看模式。保持基础 Markdown 渲染、现有的 500 行 /
50 列增强限制、daemon API 和持久化行为不变。无需浏览器 Fullscreen API 或新依赖。

## 设计

在现有表格工具栏操作旁增加本地化的全屏切换按钮。展开时将现有表格内容渲染在
共享 Dialog 中，复用 Web Shell portal、模态焦点管理及滚动锁定。表格状态仍由
原 EnhancedTable 组件持有，确保排序、筛选、列配置、密度、选区和行详情在
进入及退出全屏时保留。

展开期间保留内联表格的原高度。切换时保留表格滚动位置，关闭后将焦点返回
全屏按钮。对话框占满视口，工具栏保持可见，表格主体支持横向及纵向滚动。
在 portal 中保留 Markdown 内容样式。

全屏期间注册交互阻断。Esc 优先关闭内层菜单或单元格详情，再退出全屏，
避免触发聊天快捷键。现有作用域 portal 保持主题兼容，包括 Shadow DOM 宿主。
从实际 DOM 根节点读取焦点，并在 Shadow DOM 内约束 Tab 导航，因为 document
级焦点追踪只能看到 portal 宿主节点。
表格在渲染位置间切换时重新绑定冻结列的位置测量。

## 影响文件

- `packages/web-shell/client/components/messages/EnhancedMarkdownTable.tsx`
- `packages/web-shell/client/components/messages/EnhancedMarkdownTable.module.css`
- 同目录组件测试及浏览器回归测试。

复用现有 `common.fullscreen` 和 `common.exitFullscreen` 翻译。

## 验证与验收

- 工具栏打开唯一的、占满视口的表格，并提供可访问的退出入口。
- 排序、筛选、列宽、密度和行详情在切换后保留。
- 大表格可双向滚动，表头及工具栏始终可用。
- 全屏内的单元格详情及筛选浮层仍可交互。
- Esc 优先关闭内层界面；退出后恢复焦点及阅读位置。
- 浅色、深色主题、窄视口及作用域 portal 保持正常。
- 运行针对性的单元及浏览器测试、构建、类型检查及打包，并审查完整差异。

## 待决问题

无。全屏是临时组件状态，组件卸载时重置。
