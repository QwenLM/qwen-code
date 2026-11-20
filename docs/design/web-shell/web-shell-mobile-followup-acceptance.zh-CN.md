# 移动端 follow-up suggestion 接受

[English](web-shell-mobile-followup-acceptance.md) | [简体中文](web-shell-mobile-followup-acceptance.zh-CN.md)

状态:已在工作树实现(2026-11-20),尚未提交。

## 问题

触摸输入框(原生 `<textarea>` 后端,`(hover: none) and (pointer: coarse)`)只把 follow-up suggestion 渲染成 placeholder 灰字。桌面 CodeMirror 用 Tab / Enter / → 接受,语义是「填入输入框但不发送」;触摸后端没有对应手势。空输入点发送会整条直发,输入前缀再发送会补全直发,但两者都不允许用户先编辑再发。

两个历史决策约束本变更:mobile-composer-actions 重设计移除了旧模拟 Tab/Esc/左右键,因为当时 Tab 在 textarea 后端上是死键;#14220 移除了编辑行的 ↑/↓ 历史步进,因为历史召回统一走搜索面板,且 plain textarea 恢复无法重建 inline tag chips。因此本变更不复活历史步进。

## 设计

两个触点,一条接受路径:

- **建议条**:输入行上方,覆盖所有 composer 变体;建议文本作为可点按按钮,旁带忽略按钮。
- **编辑行填入键**:仅 default 变体(simple 变体与语音通话时编辑行不渲染);仅在有建议时出现、以本地化动作词(`Fill in` / 填入 / Вставить)为标签的按钮。标签命名动作而非桌面键名:触摸用户没有 Tab 键、也没有按 Tab 接受的肌肉记忆,`Tab` 标签会指向他们设备上不存在的硬件。

两者可见性条件一致:触摸后端已挂载、建议可见、草稿为空、composer 未禁用。开始打字即隐藏,与桌面 ghost 的前缀规则精神一致,同时保证触摸面不干扰草稿。建议条可见时触摸 textarea 保持普通占位符,建议文字只出现在一个 surface 上;早先一版曾同时留在 placeholder 里,造成同屏重复。桌面仍保留空输入 placeholder、前缀 ghost 补全的渲染。

接受调用 `onAcceptFollowup('tab')` 且不带 `skipOnAccept`,复用宿主现成的 `onAccept → insertText` 接线:在 tap 手势内填入 textarea 并 focus(iOS 只对手势内发起的 focus 弹键盘)。忽略调用 `onDismissFollowup`,保留既有 ignored 遥测。不新增数据通路:daemon sidechannel、controller、insertText 触摸分支均原样复用。

保留快路径:空输入点发送仍整条直发;输入前缀再发送仍补全直发。建议条让第一条路径可发现,但不改变其语义。

## 约束

- 44px 触摸目标;建议条仅在有建议时占一行 44px,空闲布局不变。
- textarea 保持 16px 字号(iOS focus 自动缩放规则);建议条是按钮,用 14px 弱化色 + 省略号。
- 接受按钮与编辑行其它控件一样 preventDefault mousedown,避免在手势插入前丢焦点。
- 无建议时「不出现模拟键盘键」的旧验收仍然成立;填入键是上下文触点,不是复活的死键,标签也不命名任何键盘键。

## 验证

- `client/e2e/web-shell.followup.mobile.spec.ts`,mobile-chromium(Pixel 7 触摸模拟):6/6 通过——建议条填入不发送、忽略、空输入直发、打字隐藏、前缀补全、编辑行填入键接受(标签 `Fill in`),以及建议条可见时 placeholder 保持普通文案(单 surface)。spec 会把取证截图写入其 test-results 输出目录。
- `ChatEditor.test.tsx` mobile composer actions:新增 8 条单测钉可见性(有草稿、无可见建议、桌面后端、disabled、simple 变体)与 accept/dismiss 接线;合并后 head 上连同 `i18n.test.ts` 383/383 通过。
- web-shell `tsc --noEmit` 与改动文件 ESLint:干净。
- 未覆盖:mobile-webkit / iOS 真机(本机缺 WebKit 运行库);软键盘弹起时新增行的高度挤压;iPad 外接键盘 Tab/→ 接受(后置)。

## 待定问题

无阻塞项。后续验证报告须区分 iOS 真机键盘行为与浏览器模拟结果。
