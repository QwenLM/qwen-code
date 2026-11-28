# Web Shell 输入框光晕

[English](web-shell-composer-glow.md) | [简体中文](web-shell-composer-glow.zh-CN.md)

## 行为

`WebShell` 和 `WebShellWithProviders` 接受可选属性 `composerGlowEnabled`。省略时保留当前的聚焦光晕和按键脉冲。传入 `false` 时隐藏两层光晕并跳过对应的动画监听。

## 实现

通过共享的输入框定制上下文将属性传给主聊天、分屏和侧任务。宿主在输入框挂载期间关闭开关时，输入框沿用现有的清理逻辑，取消待执行的动画帧和定时器并重置光晕状态。

## 验证

聚焦桌面输入框并打字，确认默认的光晕和脉冲。保持聚焦并将属性切换为 `false`，确认光晕层立即消失且仍可编辑草稿。切回 `true`，确认打字再次触发脉冲。
