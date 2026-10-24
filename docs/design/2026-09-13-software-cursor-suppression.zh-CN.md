# 原生光标就位时抑制重复的软件光标

[English](2026-09-13-software-cursor-suppression.md) | [简体中文](2026-09-13-software-cursor-suppression.zh-CN.md)

## 问题与范围

在 Windows 上(以及未开启同步输出的 tmux 会话中),输入框的软件光标渲染为带下划线的字符(`packages/cli/src/ui/utils/software-cursor.ts` 中的 `compositionOverlaysSoftwareCursor()` 在 `win32` 上无条件返回 `true`),因此光标停在输入末尾时会画出一个带下划线的空格——视觉上就是一个多余的 `_`。打过补丁的 ink 运行时(`patches/ink+7.0.3.patch`)还会把终端原生光标定位并显示在同一单元格上,用于锚定 IME 组合窗。于是用户同时看到两个光标:闪烁的原生光标 + 静态的 `_`。

本次改动只在原生光标即将被定位到该单元格时抑制软件光标,并且只在出现该视觉干扰的下划线光标环境中生效。色块光标环境(macOS/Linux 非 tmux)的渲染保持字节级不变。改动不影响光标所有权、IME 锚定、焦点门控(`showCursor`),也不影响对话框输入(`shared/TextInput.tsx`)——后者从不定位原生光标,软件光标是其唯一光标。

## 设计

- 在 `software-cursor.ts` 新增 `shouldRenderSoftwareCursor(physicalCursorActive, env?, platform?)`:仅当 `compositionOverlaysSoftwareCursor(env, platform)` 为 true(Windows,或未强制同步输出的 tmux)且物理光标将被定位时返回 `false`。可注入的 `env`/`platform` 参数沿用 `compositionOverlaysSoftwareCursor` 已有的可测试性模式。
- `BaseTextInput` 中,在 `setCursorPosition(cursorPosition)` 之后立即计算 `drawSoftwareCursor = shouldRenderSoftwareCursor(cursorPosition !== undefined)`。`cursorPosition` 非 `undefined` 恰好等价于 `showCursor && hasMeasured && node`——即本次渲染的 flush 会把原生光标定位并显示在光标单元格上的同一条件。该标志通过 `RenderLineOptions` 传递,自定义行渲染器同样遵循。
- `defaultRenderLine`:行尾的抑制分支保留纯空格加 `\u200B` 的尾随单元格(与现有无光标分支一致),使 Ink 仍为原生光标保留一个未被裁剪的单元格;行中则渲染纯文本。placeholder 以 secondary 色整体渲染。
- `InputPrompt.renderLineWithHighlighting` 用该标志门控其三处 `renderSoftwareCursor` 调用(行中字符、ghost-text 光标、行尾)。
- `shared/TextInput.tsx` 刻意不动:对话框输入从不设置物理光标位置,软件光标仍是它们唯一的光标。

## 取舍与风险

- 未触发输入组件重渲染的重绘(例如用户编辑中途停顿时的 spinner 帧)在 ink 的光标所有权模型下可能令原生光标短暂隐藏,此时软件光标已被抑制,直到下一次按键或组件重渲染才恢复。本次改动接受该行为。
- 挂载时 `hasMeasured` 初始为 false,首帧可能闪现一次下划线,随后原生光标接管。仅挂载时一帧。
- IME 安全性不变或更好:被抑制的单元格完全不带应用侧 SGR,原生光标仍锚定组合窗。

## 涉及文件

`packages/cli/src/ui/utils/software-cursor.ts`、
`packages/cli/src/ui/components/BaseTextInput.tsx`、
`packages/cli/src/ui/components/InputPrompt.tsx` 及其测试
(`software-cursor.test.ts`、`BaseTextInput.test.tsx`、`InputPrompt.test.tsx`)。组件测试 mock `shouldRenderSoftwareCursor`(默认返回 `true`),保证光标断言与平台无关;抑制行为由专门用例在 `chalk.level = 3` 下覆盖。

## 验证与验收

三个文件的单元测试在 Windows 与 Linux 上全部通过。Windows 上用 `npm run dev` 手动验证:输入时只可见原生闪烁光标,无静态 `_`;行中移动光标、空输入 placeholder、拼音 IME 组合输入行为不变;agent 流式输出期间输入框保持焦点时仍有可用的光标。
