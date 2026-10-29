# 默认 CU 虚拟鼠标与实时窗口预览

[English](cua-cursor-pip.md) | [简体中文](cua-cursor-pip.zh-CN.md)

状态：实施设计，2026-10-26。基线：origin/main 40f73909a9。本功能不包含独立的0.26.1回归修复与发布候选。

## 问题与当前行为

常规MCP服务会初始化原生agent cursor，但同进程SDK禁用了它。macOS cursor初始化目前阻塞于NSApplication.run，Node宿主不能直接调用。可选PiP仅展示一张动作后的PNG，缺少session/window几何数据，且它的事件循环分支绕过cursor初始化。截图上的十字标记不是桌面虚拟鼠标。

## 目标行为与范围

在常规MCP和Node REPL+SDK两条路径默认开启原生cursor，保留显式关闭能力。macOS PiP展示最近使用的最多两个已成功授权观察的窗口，按最近使用顺序叠放，不抢焦点；在对应窗口映射session cursor，无agent动作时仍刷新。Windows与X11保留原生cursor支持；本次明确不实现其现有stub PiP backend。

预览仅在本机只读展示，不向目标应用透传点击、不新增进程、不通过MP4中转、不传网络帧、不改变权限或替换桌面框架。modal或同级窗口必须分别成功通过授权观察；同PID不能授权自动加入其他窗口。

## 设计

把macOS cursor的非阻塞初始化与daemon阻塞事件循环分开。主线程host一次初始化AppKit与两个UI设施。独立宿主处理Core Foundation run loop并显式派发AppKit事件，避免调用会在启动完成后重新激活进程的NSApplication.run。每轮最多等待100ms，并在回调之间限制事件派发数量与耗时；原生拖动tracking可能持续至mouse-up。循环在owner清理期间保持运行，直到协议线程退出进程。Node在native runtime handle存活时持有引用计数、unref的timer；每次有限pump既处理主队列回调，也派发AppKit事件。Worker线程构造不能宣称具备主线程设施。关闭runtime须等待native操作与清理完成后再释放pump lease。进程级UI设施支持runtime重新创建；session内容不能残留。Node package root仅在构造期间声明UI host，并恢复之前的thread-local值；macOS原始Rust/Python embedding默认仍关闭UI。仅使用有期限的原生捕获，底层callback真实完成前保留owner lease。清理失败通过shutdown返回，并保留pump lease。

使用成功窗口观察后的内部preview-target通知，替代同步的动作后截屏推送。目标包含runtime私有session、精确window ID/PID与绑定授权context的liveness谓词。采样不刷新授权idle期限、不改变AX snapshot revision、不猜前台或main window。捕获核对当前归属、几何、权限、授权/session寿命及capture scope。目标消失或身份变化时拒绝，不回退截屏幕。

macOS controller仅在预览可见且owner有效时以约3fps采样，工作队列有界且只保留最新结果，丢弃旧generation回调。每次捕获验证source bounds、像素尺寸、身份与可用状态。保持宽高比，用相同源图到预览的几何变换投影权威session cursor。最近窗口是分别的presentation，不从Codex符号猜测原生归属算法。

显式观察与持续预览各有一个有界原生捕获 worker，后台采样不能占用显式观察的 worker。两者都保留现有捕获时限、精确窗口范围和清理回执，包括 Apple 回调尚未返回的情况。

一个进程拥有AppKit设施；预览数据与清理属于runtime/session。各session使用独立预览，其他owner不能覆盖其内容。close隐藏并停止该预览采样；session结束、撤权、runtime shutdown与reset只清对应数据。使用nonactivating panel，明确拖动区与关闭区、被动图像内容，不向目标转发输入。标签只显示app名称，不显示输入文本或原始参数。

## 原生浮动卡片展示

panel加入全部Space，保持stationary且不参与窗口循环，全屏角色仅使用AppKit的FullScreenAuxiliary，不请求FullScreenPrimary或FullScreenNone。它可能出现在桌面共享或录屏中；自动检测共享不属于本功能。关闭只停止当前预览，后续授权观察可能重新创建它。共享前需要持久关闭时，应使用现有禁用参数或配置，并重启拥有该预览的宿主。

每个私有session使用一个独立、无边框、不激活的NSPanel。窗口背景视觉透明，没有常驻标题栏。使用近透明的原生背景，使间隙仍属于本地输入区域；macOS否则会将点击穿过窗口的零alpha像素。默认位置为屏幕工作区右下角；用户可拖动卡片或明确的Move preview手柄，移动整个窗口。现有显式geometry仍指定初始位置和卡片最大尺寸。位置在该panel存活期间保留，后续刷新及卡片换层不重置位置。本轮不增加吸边、惯性、位置持久化或绑定某个客户端窗口的行为。

每个已授权来源保留独立原生卡片view、精确window身份、图像及宽高比。选择统一宽度，使所有卡片都适配配置的最大宽高及可用屏幕区域。前卡位于右下slot，另一卡向左上错开。原生窗口为两个slot保留稳定透明包络，换层不移动用户选定的窗口位置。默认卡片最大尺寸为400×300 points。各图像分别准备，sampler不再把两张卡片合成一张PNG。

鼠标移动到后卡露出区域时，该卡以前后层切换及短促临界阻尼位移动画来到前面。打断后从当前的位置和速度继续。hover只改变原生展示，不改变授权target集合、generation或idle寿命。周期图像更新保留用户选择的前卡，除非已观察来源的顺序改变。鼠标进入和离开时，浮动close与Move preview控件淡入淡出；close在视觉隐藏时仍须可通过AX访问。Move手柄明确用于拖动：不把参考素材中语义未确认的第二图标解释为向来源透传输入或激活来源应用。卡片内容也只拖动本地panel，不操作来源应用。透明间隙仍属于本地浮窗，不新增点击穿透或全局输入监听器。

悬停使用目标位置矩形，每次进入后卡区域只换层一次。卡片交换过程中，鼠标轻微移动不能再次提升新露出的另一张卡片。移到前卡目标区域或离开卡片后，才允许下次提升；有意反向切换仍从当前运动状态继续。

复用现有AppKit主线程pump与原生view。原生动画timer仅在位置或控件透明度变化时运行，close时失效；减弱动态效果设置跳过位移动画。主线程handle寿命须覆盖原生拖动的嵌套事件循环；可能重入回调的AppKit调用前释放registry/state借用。owner shutdown仍在现有主队列flush回执之前同步关闭panel。原生验收须覆盖来源不同比例、owned backdrop上的透明间隙、控件显隐、快速反向hover、拖动后持续刷新与换层、控件隐藏时AX close、后台输入不变及owner/reset清理。

## 改动覆盖

| 层次                        | 必需消费者                                                 |
| --------------------------- | ---------------------------------------------------------- |
| cursor/AppKit host          | daemon service、direct主线程host、同进程SDK与Node事件pump  |
| 内部preview target/liveness | 已验证观察dispatch、macOS采样、session/runtime清理         |
| PiP scene/layout            | 共享preview类型、macOS原生backend、cursor状态映射          |
| 默认值与打包                | SDK runtime、CLI/config、对齐的CUA版本引用与changelog      |
| 验证                        | 定向Rust/Node测试、真实默认MCP与SDK路径、E2E计划、双语文档 |

不新增daemon HTTP route。后续远程预览必须属于live-session-owner并保持runtime trust/failure语义；content-free activity observer不承载帧。

## 验证与验收

回归验收包含 Keynote 保存 Sheet：其控件报告的内部原生窗口号与外层 AXSheet 不同。刷新后的元素操作必须解析最近的 AX 窗口或 Sheet 父级，保留精确 owner 检查，并且只保存全新的测试文稿。大尺寸桌面截图须满足 Node REPL 的 4 MiB 图片限制，同时不改变截图尺寸和桌面坐标映射；过大的 PNG 在交付前改用 JPEG 编码。

模态面板快捷键使用现有精确窗口键盘门控，不经过已禁用的应用菜单。普通后台菜单快捷键在重新解析菜单项时保留字符和修饰键匹配，避免名称相同的替代菜单项造成歧义或选中不同命令。

先由test-engineer对全局qwen CLI dry-run并记录实际安装产物，再构建本地Rust/SDK/CLI，执行定向测试并按顺序build、typecheck、bundle。真实验收需独立桌面录屏、应用事件/AX/落盘readback、系统鼠标/焦点readback。覆盖默认首次动作、drag、idle fade、两个窗口、无动作实时更新、cursor缩放、PiP控件与owner独立清理。反复create/close不能留下旧窗口、采样或Node timer。

使用隔离desktop/runtime；不触碰原session的AP/R8实验及共享服务。远程前复核inventory与主机身份；不绕公司策略、TCC或签名限制。受阻平台记未验证，不记通过。创建本次已明确授权的功能PR前完成两遍clean diff审计和独立Codex review；没有合并或发布授权。原生验收还须验证：来源全屏时预览保持辅助窗口角色，不激活宿主，也不使预览自身进入全屏。

## 风险与剩余决定

主要风险是AppKit/Node事件共存、shutdown期间晚到回调、源图/cursor几何以及持续捕获授权。优先保留同进程宿主，不静默换worker。产品级PiP传输协议、native Wayland、Windows/Linux PiP属于后续范围，本次不宣称支持。实际捕获性能与权限以验收为准。
