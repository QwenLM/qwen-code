# 短终端只读滚动对话框

[English](2026-10-13-opentui-short-scroll-dialogs.md) | [简体中文](2026-10-13-opentui-short-scroll-dialogs.zh-CN.md)

## 问题与范围

MYWO-3 审计以 main `5aae8991bede510a5bde2dfe4c3b30e9bb25d4f3` 为基线：#13669 和 #13693 已合并。#12612 的 diff/subagents body 已按 region 派生高度，但至少一行 body 加六行 chrome 仍会超过 1–6 行 region。#13758 的 skills body 可归零，框架仍占六行。真实边框绘制可以越过 region 的文本裁剪。

本批修复这三个只读滚动 dialog，补充真实 session-picker resize 验证，不关闭任一复合 issue。hooks detail、确认分页/预算/分类、补全清理、transcript 延期项、剪贴板通知通道、跨平台验收、默认切换和 Ink 移除仍不在本批范围内。

## 决策

region 能支付正常边框、垂直 padding、标题和 body margin 并保留至少一行内容时，保留正常布局。否则使用紧凑 chrome：隐藏标题、垂直 padding/margin；region 至少三行时保留两行边框，1–2 行时全部用于内容。水平 padding 保持原样。未传预算时保留原始 body 上限（diff 14；skills/subagents 12）。

无边框使用 `border=[]`：OpenTUI 0.5.10 在同时传颜色/样式时会隐式启用 false 边框。框架样式变化时重挂载，因为移除的布局属性可能残留。滚动框 key 包含尺寸，以便 resize 后重新应用 `flexShrink=1`；复用的原生节点设置尺寸会将其清零。resize 会重置滚动位置，但加载的内容保存在组件状态中，可再次滚动读取。视觉提示隐藏时 Escape 仍有效。

skills 标题按真实内容宽度截断；标题和关闭提示无法共占一行时隐藏关闭提示，使窄终端下正常 chrome 的六行计费仍成立。

## 验证与验收

原生 Bun 脚本在宽度 11/20/40/100、region 高度 1–8/12/15/40 下运行真实组件：框架高度及绘制的边框必须留在 region 内。增减尺寸测试必须能读取 fixture 最后一行，并在重挂载 body 上保留原生 Yoga shrink。真实 session picker 的 list 和 preview resize 必须重挂载且保持 Yoga shrink 1。快速单测约束无预算行为和正常/紧凑布局转换；既有 Ink dialog 测试及 component parity 验证共享 renderer 的回归边界。

移除紧凑 chrome 或尺寸 key 后，mutation 检查必须失败。交付前须通过 build、typecheck、相关 lint 和 unit/native 检查。证据来自本机 macOS/Bun 原生无头渲染；Linux、Windows、tmux 和实际鼠标滚动体验需要另行验收。原生无头帧不代表真实终端录像。

已确认的残余缺陷：11 列下正文可能因 flex 列被挤空，原生 Text 单节点跨多行时滚动到尾部也可能无法显示尾部字形。独立最小 @opentui 0.5.10 probe 可复现。此次保留原正文行布局；11 列只验证区域几何，内容可达性在 20/40/100 列验证，不能据此声称极窄正文已修复。
