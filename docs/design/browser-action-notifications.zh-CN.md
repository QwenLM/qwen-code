# 用户操作的浏览器通知

[English](browser-action-notifications.md) | [简体中文](browser-action-notifications.zh-CN.md)

## 问题与范围

浏览器任务通知目前只覆盖回合结束和失败。用户离开页面后，聊天可能停在工具审批或
AskUserQuestion 等待回答的状态，却没有提醒。为当前聊天和仍挂载的分屏聊天增加这两种
等待提醒，共用现有通知开关。

## 设计

两种交互均来自 `permission_request` 事件。对匹配且尚未解决的 transcript 块复用
`extractPendingPermission` 和 `isAskUserPermission`，使通知分类与交互 UI 一致。
观察实时权限请求前刷新缓冲的 transcript 事件，确保相应块已可读取。不修改 daemon、
SDK、审批策略或路由；请求与点击目标保留现有的会话／工作区作用域。

共享通知观察器在终态事件的 prompt 校验前处理这类请求，因为权限请求需要的是
`requestId`，而非 `data.promptId`。去重键包含作用域、`permission` 标识和请求 ID。
重复请求和重复面板仅提醒一次，并与回合结束的去重键独立。前台或关闭通知时收到的
请求仍记为已处理，之后不补发，与现有回合通知行为一致。快照重放保持静默，包括历史
中已经解决的请求；本次不增加断线期间错过的权限请求补发。

复用浏览器权限校验、偏好持久化、Web Locks／共享认领、品牌、多语言和点击导航。
标题包含会话名；正文只提示需要审批或需要回答。不将命令、路径、问题文本、选项或
助手的部分回复复制到这些通知中。点击后聚焦窗口并打开捕获的原会话，不自动回答或
批准任何请求。与之前一样，通知需要网页打开、聊天仍挂载且浏览器和系统允许通知；
本次不是后台推送服务。

## 影响文件

- `packages/web-shell/client/daemon/session/turn-notification-context.ts` 及其
  测试：分类并去重实时操作请求。
- `packages/web-shell/client/daemon/session/DaemonSessionProvider.tsx`：观察前
  刷新权限投影。
- `packages/web-shell/client/adapters/transcriptAdapter.ts`、
  `packages/web-shell/client/utils/askUserPermission.ts` 和
  `packages/web-shell/client/components/messages/toolFormatting.ts`：补全 `.js`
  导入路径，使复用的辅助函数也通过 NodeNext 集成类型检查。
- `packages/web-shell/client/browser-turn-notifications.tsx` 及其测试：共享
  一次性授权逻辑，覆盖浏览器发送和导航路径。
- `packages/web-shell/client/components/messages/BrowserNotificationControl.tsx`、
  `ToolApproval.tsx` 和 `AskUserQuestion.tsx`：在两种操作面板中提供通知状态、
  授权及系统设置指引。
- `packages/web-shell/client/i18n.tsx` 和 `packages/web-shell/README.md`：在适用
  位置同步中英文说明，补充两个触发条件。
- `packages/web-shell/client/e2e/web-shell.browser-notifications.spec.ts`：结合
  模拟 SSE 与 Notifications API 捕获验证页面行为。

## 验证与验收

1. 后台实时工具审批产生一次本地化审批提醒；实时 AskUserQuestion 产生一次回答提醒。
2. 前台、开关关闭、权限拒绝、历史、已解决和会话不匹配的请求不提醒。重复请求和重复
   面板不会重复提醒；同一回合中的不同请求互相独立。
3. 请求提醒不会消费后续的回合结束通知。
4. 点击通过现有导航打开原会话，不提交审批或答案；通知正文不泄露请求详情。
5. 聚焦单测和浏览器 E2E 通过，并验证构建与类型检查。E2E 使用模拟 daemon 和
   Notification 捕获，不能证明原生系统通知展示或真实后端审批执行。

## 待定问题

无。iframe 支持、断线补发以及已展示提醒的自动关闭均不在本次范围内。

## 操作面板中的通知入口

ToolApproval 与 AskUserQuestion 在标题右上角共用通知状态按钮，覆盖内联、浮层和分屏。
复用现有带作用域的 Popover 与 Button。鼠标悬停、键盘聚焦或点击均可打开可交互的说明，
且不抢走审批选项的焦点；鼠标移入内容后保持打开。Escape 只关闭说明，不拒绝或提交
请求。隔离说明中的键盘事件，避免触发面板快捷键。

图标与本地化状态区分已开启且站点已授权、已关闭、未授权、已拒绝和环境不支持。
没有通知上下文（包括 iframe 或未接入通知的宿主）不渲染该入口。在可用时提供现有
开启／授权操作；拒绝后说明如何修改浏览器站点设置。说明涵盖后台／失焦的触发条件、
聊天需保持挂载、点击行为，以及 macOS／Windows 的通知和专注设置。两种系统指引默认
收起，标题旁带箭头，可独立展开或收起。网页无法检测系统权限，不声称可以检测。

首次符合条件的面板出现时，通过现有设置控制器为当前浏览器站点尝试一次授权。
调用 API 前记下尝试，避免分屏和 Strict Mode 重复触发；存储不可用时使用内存去重。
仅在权限为 default 且用户没有明确保存关闭选择时尝试。关闭授权提示、拒绝或刷新后
均不自动重试。浏览器可能拦截缺少用户手势的申请，因此始终保留手动按钮。不通过定时、
模拟点击或重复申请绕过浏览器规则；成功授权后开启现有偏好。仅打开应用仍不会申请。

增加控制器单测，覆盖一次性尝试与明确关闭／拒绝／不可用状态；浏览器 E2E 覆盖两个
面板的入口、从图标移动到说明、手动授权、已开启／拒绝文案、键盘隔离、尝试记录持久化
和截图。系统指引依据 [Apple 通知设置](https://support.apple.com/en-gb/guide/mac-help/-mh40583/mac)
与 [Microsoft 通知／请勿打扰文档](https://support.microsoft.com/en-us/windows/experience/notifications-and-do-not-disturb-in-windows)。
E2E 使用隔离的模拟 API，不操作用户权限。
