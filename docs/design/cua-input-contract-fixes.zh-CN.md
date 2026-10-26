# CUA 0.26.1 输入与会话修正

[English](cua-input-contract-fixes.md) | [简体中文](cua-input-contract-fixes.zh-CN.md)

## 状态与范围

遵循已有发布约束，一起准备 native driver、CUA SDK、Browser SDK 与 Node REPL 0.26.1。浏览器行为和 Qwen Code CLI 版本不属于本次改动。

22 个文件的输入/会话修复补丁与四组正在运行的 RecreationBench 实验所用的 `0b2ec12bab99` 补丁一致，发布准备时已将其迁到当前 main。实验保留原有 0.26.0 包元数据及不可变归档，发布元数据变化不会升级或重启实验。用户明确授权在 macOS 完整 case 尚未验收时启动 full，结果仍待完成。

## Windows 分发与清理

UIA provider 可能在模态打开期间一直停留在动作内部。被点击的菜单弹出窗口可能消失，新出现的同进程对话框也可能没有 owner。只等待属于原弹出窗口的对话框会漏掉这种变化。

记录精确目标 HWND/PID 及已有同进程可见窗口。只有原生调用开始后，才将目标消失或受支持的“目标变为 disabled 并出现新模态”变化识别为 pending。保留严格的所有权、捕获与前台授权辅助逻辑。direct/embedded 的 click 与 secondary-action 路径会保留 COM 引用、NoActivate、会话 dispatch 和 runtime drain guard，直到原操作结束。目标消失或无 owner 模态的回执仍未确认，要求继续观察；原有 owned-surface 证据保留其分类。不重放输入。

输入前发现 UIA pattern 不受支持时可以选择其他执行器，其他 pattern 查询错误则拒绝分发。可能已投递输入后的错误不能触发另一执行器。绑定 SDK 会话关闭会等待 typed `session_cleanup_pending` 中间状态，保留 handle 直到获得最终结果，并传出最终清理错误。成功的清理 hook 保留现有去重行为，失败 hook 保留原有处理语义。

## 其他 Windows 修正

前台 SendInput 预检识别实际 TokenUIAccess 值。posted-message 与合成指针 guard 保持更严格的限制，不增加进程提权或签名 worker 安装。

当 ComboBoxEx 内部 combo 的 style 表示仅列表时，实际 Edit 子控件可标识可编辑路径。保留现有值/索引回读，以及无 Edit 列表对未知值的拒绝。

## macOS 身份与输入

当 `PROC_PIDTBSDINFO` 不可用时，`KERN_PROC_PID` 可提供相同的微秒级进程出生身份。拒绝无效 PID、不完整数据、PID 不匹配和无效时间戳，保留后续生命周期检查。该历史故障不能确定后来每次输入没有可见效果的原因。

键盘、指针、交互输入及光标事件构造共用 CombinedSessionState 事件源，避开已观测的硬件事件源构造挂起。投递目标、显式 modifier、PID/窗口检查及成功路径的焦点恢复策略不变。

key-focus tap 初始化失败时仅回滚注册、计数、tail 与 idle teardown，不构造代表已完成动作的 lease，因此不会在动作发生前执行动作后恢复。secondary action 除 raw/lowercase 形式外，也接受精确的大小写保留 advertised 别名；保留 membership 和歧义检查，不增加隐式 AXPress 或像素回退。

## 剪贴板启动握手

只将剪贴板事务的主线程启动等待限制为三秒。排队 callback 与超时等待者通过 mutex 共用可选闭包。超时可以取走并释放尚未开始的工作，防止迟到的剪贴板写入。callback 一旦取走工作，就继续等待完成，并保留 mutation/clipboard lease 直到恢复结束。所有权检查与恢复不会在事务中途取消。

对于没有处理 AppKit 主队列的 host，此路径安全拒绝，不安装其他 GUI host、不改变身份、不重放 paste。

## 模型可见文档

Node REPL 初始说明引导模型在桌面动作前使用 `cua.getState()` 或查看运行时文档。App-option 示例区分数字 ID、按键数组及 JavaScript 执行超时与 app options，不编造兼容 API。

## 验证与待完成的验收

公共 SimpleConvert 仅增加一行 Qt6 翻译路径 API 兼容改动，模态构造不变，在真实 Windows 上复现了 30.341 秒 click 等待。修复后的 MCP click、SDK click、secondary invoke 分别在 150/153/149 毫秒返回。独立 AX/PNG 观测确认模态出现后，每轮仅受控关闭一次。SDK dispose 等待 25.681 秒后实际成功，没有把捕获到的错误当成成功。这些是限定范围的主机结果，不是延迟保证，也不能证明每次历史 AP 调用的根因。

原生测试覆盖 pending 窗口变化、执行器选择、会话/runtime 生命周期保留、最终清理失败、剪贴板 callback 取消及出生身份。发布准备同时执行版本、build、typecheck 与打包检查。

TextEdit 输入及保存文件回读在已测 macOS 身份/目标范围内通过。JSONExport 输入一致性仍未验收：公司策略在输入前终止主机的自编译 app，AP 的 typeText 无变化症状也仍未解决。该策略不能确定 AP 根因。可选 UIAccess worker 行为、Linux GUI 一致性、完整 benchmark 质量及未来发布的 0.26.1 安装路径均未标记通过。

发布验收需要对应产物、适用场景下的正常签名分发、校验和验证的安装及有意义的运行时效果。构建、权限、回执和 Running 状态不能替代这些结果。本次不包含权限、安全防护、账号或模型变更。
