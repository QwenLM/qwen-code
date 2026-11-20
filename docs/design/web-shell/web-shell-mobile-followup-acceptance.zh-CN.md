# 移动端 follow-up suggestion 接受

[English](web-shell-mobile-followup-acceptance.md) | [简体中文](web-shell-mobile-followup-acceptance.zh-CN.md)

状态:已实现于 `feat/web-shell-mobile-followup-acceptance`(PR #17918),2026-11-20 经多轮评审修订(Tab 键 → 动作词键 → 单 chip 建议条 → 光标/斜杠键排 → 240px 换行修复)。

## 问题

触摸输入框(原生 `<textarea>` 后端,`(hover: none) and (pointer: coarse)`)只把 follow-up suggestion 渲染成 placeholder 灰字。桌面 CodeMirror 用 Tab / Enter / → 接受,语义是「填入输入框但不发送」;触摸后端没有对应手势。空输入点发送会整条直发,输入前缀再发送会补全直发,但两者都不允许用户先编辑再发。

两个历史决策约束本变更:mobile-composer-actions 重设计移除了旧模拟 Tab/Esc/左右键,因为当时 Tab 在 textarea 后端上是死键;#14220 移除了编辑行的 ↑/↓ 历史步进,因为历史召回统一走搜索面板,且 plain textarea 恢复无法重建 inline tag chips。因此本变更不复活历史步进。

## 设计

一个触点,一条接受路径:

- **建议 chip 条**:输入行上方,覆盖所有 composer 变体;chip 样式的可点按按钮,标签即建议文本本身,前带插入图标,旁带忽略按钮。编辑行不带 follow-up 专用控件;其 → 光标键兼作同一接受(对齐桌面 ArrowRight)。

单 chip 出自三轮评审;后续轮次加入下文的光标/斜杠键排与窄屏换行。第一版加建议条与编辑行 `Tab` 键;评审指出触摸用户没有 Tab 键与相应肌肉记忆。第二版把该键改本地化动作词(`Fill in` / 填入 / Вставить);评审指出光秃及物动词仍缺宾语,且与建议内容空间分离。终版删除编辑行键,并给建议条 chip 容器(浅底、描边、插入图标),使其在无 hover 的触摸端读作可点:内容即标签,是最易懂的形态,也与业界移动建议 chip 一致。随键删除的还有 `composerMobile.fillFollowup` 目录键。

第四轮评审在编辑行尾侧(default 变体、触摸)加入始终有活功能的编辑键:↑/↓ 行感知移动光标(列钳制到目标行、首/末行出界钳到文档首/尾);→ 光标右移,并在建议匹配时兼作桌面 ArrowRight 式接受(整草稿替换为补全,遥测 method `right`);/ 插字面斜杠——textarea 后端没有 slash 菜单,该键是字符便利键,命令浏览仍在加号抽屉。IME 组合期间按键让路;纯光标移动不碰草稿与其持久化。simple 变体与语音通话时编辑行不渲染,键排缺席。历史召回仍走搜索面板:不复活步进回调,故 #14220 移除步进的 inline-tag-chip 限制不适用。

可见性:触摸后端已挂载、建议可见、草稿为空、composer 未禁用。开始打字即隐藏,与桌面 ghost 的前缀规则精神一致,同时保证触摸面不干扰草稿。chip 可见时触摸 textarea 保持普通占位符,建议文字只出现在一个 surface 上;早先一版曾同时留在 placeholder 里,造成同屏重复。桌面仍保留空输入 placeholder、前缀 ghost 补全的渲染。

接受调用 `onAcceptFollowup('tab')` 且不带 `skipOnAccept`,复用宿主现成的 `onAccept → insertText` 接线:填入 textarea 并请求 focus;宿主 accept 经 `queueMicrotask` 延迟插入,故真 iOS 上 focus 可能落在 tap 手势之外、键盘可能不弹——真 iOS 键盘行为未验证、属范围外。忽略调用 `onDismissFollowup`,保留既有 ignored 遥测。不新增数据通路:daemon sidechannel、controller、insertText 触摸分支均原样复用。

保留快路径:空输入点发送仍整条直发;输入前缀再发送仍补全直发。建议条让第一条路径可发现,但不改变其语义。

## 约束

- 44px 触摸目标;chip 行仅在有建议时占一行 44px,空闲布局不变。
- textarea 保持 16px 字号(iOS focus 自动缩放规则);chip 是按钮,14px 文本 + 插入图标 + 单行省略。
- chip 与其它输入框控件一样 preventDefault mousedown,避免在手势插入前丢焦点;aria-label 组合本地化动作与建议文本,屏幕阅读器两者都得。
- 「不出现模拟键盘键」的旧验收仍然成立:没有 follow-up 控件命名键盘键或光秃动词;编辑行键是有原生语义的光标/字符键,不是模拟接受/历史键。
- 编辑键在 IME 组合期间让路(compositionstart/end 门控);纯光标移动不改草稿,草稿持久化与历史浏览状态不受影响。

## 验证

- `client/e2e/web-shell.followup.mobile.spec.ts`,mobile-chromium(Pixel 7 触摸模拟):13/13 通过——chip 填入不发送、忽略、空输入直发、打字隐藏、前缀补全、编辑行不带 follow-up 专用键而 chip 接受(default 变体)、chip 可见时 placeholder 保持普通文案(单 surface)、光标上/下/右移动、→ 接受可见建议、前缀草稿下右键标签/接受同步、字面斜杠插入、390px 同行/240px 自占行且无横向溢出,以及两条 zh-CN 用例钉住本地化 chip 文本、忽略标签与光标键标签并截中文 UI 图。这些用例传 `?language=`,由 App 的 `getInitialLanguage` 直接读取(无需 harness prop);spec 会把取证截图写入其 test-results 输出目录。
- `ChatEditor.test.tsx` mobile composer actions:单测钉可见性(有草稿、无可见建议、桌面后端、disabled、simple 变体)、accept/dismiss 接线、编辑键接线与 → 的动态 aria-label;`useComposerCore.test.ts` 钉行感知光标计算;合并后 head(含 main incoming)上三个文件 404/404 通过。
- web-shell `tsc --noEmit` 与改动文件 ESLint:干净。
- 未覆盖:mobile-webkit / iOS 真机(本机缺 WebKit 运行库);软键盘弹起时新增行的高度挤压;iPad 外接键盘 Tab/→ 接受(后置)。

## 待定问题

无阻塞项。后续验证报告须区分 iOS 真机键盘行为与浏览器模拟结果。
