# 延后交互用户启动警告

[English](2026-11-16-deferred-user-startup-warnings.md) | [简体中文](2026-11-16-deferred-user-startup-warnings.zh-CN.md)

## 问题与范围

工作目录及ripgrep可用性检查可能耗时。交互用户应能在这些非关键检查完成前看到并使用界面，随后仍收到警告。本改动不关闭检查、不隐藏失败、不延长就绪期限，也不改变权限。

仅延后交互用户警告检查。安全模式、文件、设置、配置、认证及中断工作流处理保留既有启动路径。Headless与ACP仍等待原警告检查并保持stderr顺序。迟到警告不会通过stderr破坏已经绘制的终端界面。

## 请求与显示

启动过程为捕获的Config、工作目录及检查选项创建一次promise和AbortController。在任一UI订阅前立即观察reject。同一个请求沿真实Ink与Native入口传递，包括renderer回退；React渲染不会再次启动检查。

小型共享hook仅向匹配的Config/request/工作目录selection提供结果。Ink将字符串合并到现有Notifications，不把foreign请求的结果写入初始警告state。Native追加warning transcript事件并按文本去重。请求reject会成为可见警告，不会静默消失。

## 所有权与清屏

请求属于一次应用启动，而非conversation ID。同工作区clear保留已显示警告，不重新检查。Native transcript reset重建当前owned warnings；Config替换或StrictMode重放先替换旧警告投影，再重放Mod通知。首次空history启动保留既有行为。

每个effect订阅在cleanup后永久失效。Config或request替换、工作目录改变、卸载及请求abort都会拒绝迟到callback；A到B再回A不会复活旧订阅。Owner不匹配时首帧也不返回旧结果。Unknown或foreign owner不能回退到另一个Config。

StrictMode退订不abort共享请求。下一订阅仍可收到同一个已完成结果，重复字符串只显示一次。

## 退出与限制

真实退出通过现有优先cleanup选项注册abort后等待settle的清理。Ripgrep接收已有公开AbortSignal，并等待其支持的子进程close。不增加Core实现或运行时选项。非交互执行保留原无signal调用。

这里无法物理取消filesystem realpath。撤销后丢弃迟到结果，cleanup仍可能触及既有每函数两秒或总共五秒上限。本改动不保证所有底层filesystem工作都已消失，也不改变进程重启或信号策略。Clear不是退出cleanup。

## 验证与验收

Bootstrap回归必须保持非关键检查未完成，要求其结束前UI已启动，同时仍传入critical file warnings。Headless与ACP测试必须保留原等待检查及stderr顺序。取消测试必须验证公开signal确已传入、cleanup恰一次abort并等待可支持的close，以及迟到realpath结果被丢弃；不能声称物理取消realpath。

Renderer测试必须检查真实Ink Notifications输出与Native warning transcript，不能只断言props传递。覆盖迟到成功、可见reject、字符串去重、clear/reset重建、owner替换、A到B再到A后的旧callback、卸载与StrictMode重新订阅。Conversation clear或effect重新订阅不得再次执行检查。

真实PTY测试必须证明受控非关键检查未完成时prompt可用，随后警告恰一次显示，且clear后保留。还须单独覆盖可支持工作未完成时退出，并在真实UI支持owner替换的路径拒绝旧owner结果。使用owned配置/工作区/runtime夹具，保留默认权限与原测试期限，在helper cleanup前检查产品自然退出。轮询顺序或身份observer证据缺口既不是功能通过，也不能直接判定产品缺陷。

在build、typecheck、受影响完整单测、lint、format及bundle检查后，针对精确的独立source-bundle产物验证Node+Ink、Bun+Ink和strict Native。另一个组合功能树的证据不能授予本产物资格。既有重启与信号回归是独立合同，不得暗中归功于警告改动。提交前须完成验证后自审与非作者审查。

Filesystem取消限制及既有cleanup上限仍是验收边界。Windows、IME、安装分发、长期稳定性与整体UI迁移都需要各自证据。本设计定义测试责任，不充当持续变化的运行状态台账。
