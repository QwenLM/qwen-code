/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type BrowserNotificationMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const BROWSER_NOTIFICATION_MESSAGES_EN: Record<
  string,
  BrowserNotificationMessage
> = {
  'browserNotifications.label': 'Task notifications',
  'browserNotifications.description':
    'Notify when the current chat or a split-view chat finishes, fails, needs approval or waits for your answer while this page is in the background or unfocused. Completed turns show prompt and reply excerpts; action reminders show the session title and waiting status. Saved for this browser site only; the page must remain open.',
  'browserNotifications.prompt': (v) => `Prompt: ${v?.text ?? ''}`,
  'browserNotifications.reply': (v) => `Reply: ${v?.text ?? ''}`,
  'browserNotifications.completed': 'This turn has completed.',
  'browserNotifications.failed':
    'This turn failed. Return to view the details.',
  'browserNotifications.ended':
    'This turn has ended. Return to check the result.',
  'browserNotifications.approval':
    'This session needs your approval. Return to review the request.',
  'browserNotifications.question':
    'This session is waiting for your answer. Return to respond.',
  'browserNotifications.allow': 'Allow notifications',
  'browserNotifications.enable': 'Enable notifications',
  'browserNotifications.helpEnabled': 'Enabled for this site.',
  'browserNotifications.helpWaiting': 'Notifications are not authorized yet.',
  'browserNotifications.helpWhen':
    'While this page is in the background or you switch to another tab, get reminders when the current chat needs approval, waits for your answer, finishes or fails. Clicking a notification returns to its chat without approving or answering.',
  'browserNotifications.helpSystem':
    'If no reminders appear, follow the steps below to check system notifications.',
  'browserNotifications.helpMac':
    'Open System Settings → Notifications. Select your browser (for Chrome, also check Google Chrome Helper (Alerts) if listed), enable notifications and desktop banners/alerts. Check Focus and whether notifications are allowed during screen sharing.',
  'browserNotifications.helpWindows':
    'Open Settings → System → Notifications (Windows 10: Notifications & actions). Enable notifications and your browser, including notification banners. Turn off Do not disturb / Focus assist, or allow your browser through its rules.',
  'browserNotifications.enabled': 'Enabled.',
  'browserNotifications.disabled': 'Disabled.',
  'browserNotifications.waiting': 'Waiting for browser permission.',
  'browserNotifications.denied':
    'Notifications are blocked. Allow them in your browser site settings.',
  'browserNotifications.unavailable':
    'Notifications are unavailable in this browser or page context.',
  'browserNotifications.requesting': 'Waiting for your permission…',
  'browserNotifications.error':
    'Unable to enable or show notifications. Check your browser and system settings.',
  'browserNotifications.temporary':
    'This setting is saved for the current page only.',
};

export const BROWSER_NOTIFICATION_MESSAGES_ZH: Record<
  string,
  BrowserNotificationMessage
> = {
  'browserNotifications.label': '任务通知',
  'browserNotifications.description':
    '页面在后台或窗口失焦时，提醒当前聊天和分屏聊天的回合结束、失败、需要审批或等待回答。回合结束通知包含提问和回复摘录；待处理提醒只显示会话标题和等待状态。仅保存在此浏览器站点；网页需保持打开。',
  'browserNotifications.prompt': (v) => `提问：${v?.text ?? ''}`,
  'browserNotifications.reply': (v) => `回复：${v?.text ?? ''}`,
  'browserNotifications.completed': '本轮已完成。',
  'browserNotifications.failed': '本轮执行失败，请返回查看。',
  'browserNotifications.ended': '本轮已结束，请返回查看结果。',
  'browserNotifications.approval': '此会话需要你的审批，请返回查看请求。',
  'browserNotifications.question': '此会话正在等待你的回答，请返回处理。',
  'browserNotifications.allow': '允许通知',
  'browserNotifications.enable': '开启通知',
  'browserNotifications.helpEnabled': '已为此站点开启通知。',
  'browserNotifications.helpWaiting': '尚未获得浏览器通知授权。',
  'browserNotifications.helpWhen':
    '页面在后台或者切换到其他页签时，当前聊天需要审批、等待回答、回合结束或失败会发送提醒，点击通知返回对应聊天，不会自动审批或回答。',
  'browserNotifications.helpSystem':
    '如果没有收到提醒，请按下方指引检查系统通知',
  'browserNotifications.helpMac':
    '打开“系统设置 → 通知”，选择浏览器（Chrome 如列有 Google Chrome Helper (Alerts)，也需检查），开启允许通知及桌面横幅／提醒。检查专注模式，以及屏幕共享时是否允许通知。',
  'browserNotifications.helpWindows':
    '打开“设置 → 系统 → 通知”（Windows 10 为“通知和操作”），开启通知及浏览器通知，并允许显示通知横幅。关闭“请勿打扰／专注助手”，或在其规则中允许浏览器通知。',
  'browserNotifications.enabled': '已开启。',
  'browserNotifications.disabled': '未开启。',
  'browserNotifications.waiting': '等待浏览器授权。',
  'browserNotifications.denied': '浏览器已阻止通知，请在浏览器站点设置中允许。',
  'browserNotifications.unavailable': '当前浏览器或页面环境无法使用通知。',
  'browserNotifications.requesting': '等待你的授权…',
  'browserNotifications.error': '无法启用或显示通知，请检查浏览器及系统设置。',
  'browserNotifications.temporary': '设置仅在当前页面有效。',
};
