# 状态栏预设配色与实时预览

[English](statusline-preset-live-preview.md) | [简体中文](statusline-preset-live-preview.zh-CN.md)

## 问题与现状

Issue [#8363](https://github.com/QwenLM/qwen-code/issues/8363) 要求为预设项添加语义
配色，并在真实状态栏中预览。Ink 和 OpenTUI 目前将所有预设统一显示为 accent
色，在选择器内显示截断的预览，并在打开选择器时替换输入区域。

## 方案

配置预设时保留真实输入区域和 footer，同时禁用输入，使选择器独占键盘事件。
选择器挂载及每次切换选项时，将临时预设配置传递给共享状态栏 hook，关闭时清除。
Enter 写入实际生效的设置作用域；Escape 取消且不写设置。预览和保存配置都保留
显式的 `hideContextIndicator` 值。
同时禁用原生 textarea 的可聚焦能力，避免鼠标点击在选择器打开时重新取得
键盘或粘贴事件。

复用保存后状态栏的现有渲染器、宽度、换行方式和两行上限。当前 main 的真实
状态栏位于输入框下方的 footer，与 issue 中“输入框上方”的描述不同。本次保留
保存后的布局，在输入区域上方放置配置选择器，而非另建预览。移除两个选择器内
的预览及其行预算；计算选择器高度时为输入区域和 footer 预留空间。

使用完整且由编译器检查的映射，为所有可用项按类别配色：

| 类别           | 预设项                                                                                                     | 主题 token     |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| 项目与 Git     | project-name, git-branch, current-dir, pull-request-number, branch-changes                                 | status.success |
| 模型与推理     | model, model-with-reasoning                                                                                | text.accent    |
| 上下文与 token | context-remaining, context-used, context-window-size, used-tokens, total-input-tokens, total-output-tokens | text.link      |
| 会话元数据     | run-state, qwen-version, session-id                                                                        | status.warning |

共享预设格式化函数使用当前语义主题生成 ANSI 样式，两个现有渲染器均已支持。
分隔符使用中性色。`useThemeColors: false` 时输出纯文本，保留现有 footer 的
暗化样式。在渲染时解析颜色，避免缓存旧主题颜色，并支持命名主题及 NoColor。
OpenTUI 的预设行不再对格式化输出叠加 accent 底色，确保 NoColor 的空颜色
token 保持无色。

## 影响范围

- `packages/cli/src/ui/statusLinePresets.ts` 和 `hooks/useStatusLine.ts`：
  共享语义格式化与临时配置优先级。
- Ink `AppContainer.tsx`、UI contexts、`StatusLineDialog.tsx`、
  `DialogManager.tsx`、`Composer.tsx`、`InputPrompt.tsx` 及 layouts：
  草稿生命周期、可见但禁用的输入以及选择器高度限制。
- OpenTUI `dialogs-statusline.tsx`、`opentui-dialog-mount.tsx`、
  `opentui-app-shell.tsx`、`input-prompt.tsx` 和 `opentui-footer.tsx`：
  对应的草稿生命周期、布局、输入归属及样式。
- 格式化、hook、选择器、布局、shell 的专项测试与用户文档。

## 决策与边界

不保存中间选择，不改变自定义命令输出语义。选择器打开时，草稿可覆盖命令型或
禁用的状态栏；取消时必须恢复。区分已保存 override 和草稿，防止陈旧的保存
override 覆盖命令型或 `null` 设置。紧凑选择器可用高度至少七行时保留搜索：搜索占三行，选项至少四行。
更小的选择器把全部行用于选项；完整边框和说明仍需十六行。不新增持久化
设置、不迁移配置、不取消状态栏高度上限，也不进行无关布局改造。

OpenTUI 初始为输入区和页脚预留七行，再测量选择器下方控件的实际高度。
草稿换行或页脚增加行数时缩小选择器；草稿收起后恢复选择器可用行数。

## 验证与验收标准

在宽、窄、矮终端中检查两个渲染器。切换选项必须立即改变真实 footer，不再
出现边框内预览。输入区域和 footer 保持可见，选择器按键或粘贴不能提交或改变
输入框。Enter 只保存一次，保存后输出与预览一致；Escape 恢复原有预设、命令型
或禁用配置且不写设置。每个内置项属于唯一配色类别；切换主题时更新颜色，禁用
主题配色时移除颜色。运行专项单测、build、typecheck、bundle 与隔离交互测试。

## 待定问题

无。保留真实 footer 的当前位置和现有两行上限，不将本需求扩展为全局状态栏
重构。
