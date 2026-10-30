# CUA 0.27.0 输入与会话修正

[English](cua-input-contract-fixes.md) | [简体中文](cua-input-contract-fixes.zh-CN.md)

## 状态与范围

遵循已有发布约束，一起准备 native driver、CUA SDK、Browser SDK 与 Node REPL 0.27.0。输入投递、窗口选择和生命周期回报修正与 main 已有的光标/PiP 功能一起进入本次发布。本次改动保留这些功能，浏览器行为及 Qwen Code CLI 版本不变。

此前真实主机验证使用带 0.26.0 兼容元数据的私有不可变制品。证据适用于对应功能修正，不代表生产签名、未来 0.27.0 制品安装或完整 benchmark 已验收。本次发布准备不操作实验或定时监控。

## Windows 分发与清理

UIA provider 可能在模态打开期间一直停留在动作内部。被点击的菜单弹出窗口可能消失，新出现的同进程对话框也可能没有 owner。只等待属于原弹出窗口的对话框会漏掉这种变化。

记录精确目标 HWND/PID 及已有同进程可见窗口。只有原生调用开始后，才将目标消失或受支持的“目标变为 disabled 并出现新模态”变化识别为 pending。direct/embedded 的 click 与 secondary-action 路径保留 COM 引用、NoActivate、会话 dispatch 和 runtime drain guard，直到原操作结束。目标消失或无 owner 模态的回执仍未确认，要求继续观察；原有 owned-surface 证据保留其分类。不重放输入。

输入前发现 UIA pattern 不受支持时可以选择其他执行器，其他 pattern 查询错误则拒绝分发。可能已投递输入后的错误不能触发另一执行器。绑定 SDK 会话关闭会等待 typed `session_cleanup_pending` 中间状态，保留 handle 直到获得最终结果，并传出最终清理错误。成功清理 hook 保留现有去重行为。

## Windows 目标选择与读回

应用在后台时，先从候选 owner 开始选择窗口，避免选中非活动 owned 辅助窗口，然后保留已有且经过校验的 `GetLastActivePopup` 提升逻辑。精确前台优先、同 PID/owner-chain 检查、独立小窗口及单一最小化窗口分支不变。截图裁剪与坐标转换不变，不用整桌面像素替换小截图，也不降低调用方的图像大小门槛。

旧 PostMessage 文本输入只读回精确缓存元素。没有元素索引时，不再查询可能阻塞或指向其他接收者的系统级焦点 UIA 元素。回执保持未验证，要求再次输入前先进行新观察。仅值发生变化不能证明插入点正确。

当 ComboBoxEx 内部 combo 的 style 表示仅列表时，实际 Edit 子控件可标识可编辑路径。保留现有值/索引回读，以及无 Edit 列表对未知值的拒绝。前台 SendInput 预检识别实际 TokenUIAccess 值；posted-message 与合成指针 guard 保持更严格的限制。不增加提权或签名 worker 安装。

## macOS 身份与发现

应用清单保留标准安装目录之外正在运行的 Accessory 应用，让精确 bundle ID 查询可以找到菜单栏应用。Prohibited 后台进程仍要求匹配已安装 bundle，原有仅枚举 Regular 应用的路径不变。发现层修正不等于提供窗口，也不代表无窗口应用的 GUI 已验收。

当 `PROC_PIDTBSDINFO` 不可用时，`KERN_PROC_PID` 可提供相同的微秒级进程出生身份。拒绝无效 PID、不完整数据、PID 不匹配和无效时间戳，保留后续生命周期检查。Objective-C 类工厂的可用性在类对象上检查，不再查询实例是否实现该工厂。

## macOS 键盘与文本投递

键盘、指针、交互输入及光标事件构造共用 CombinedSessionState 事件源。投递目标、显式 modifier 与逻辑 PID/窗口检查保留。key-focus tap 初始化失败时仅回滚注册、计数、tail 与 idle teardown，不构造已完成动作的 lease，也不执行动作后恢复。

对于由辅助 AX host 实现的已聚焦 Open/Save 输入框，解析实际键盘接收者，同时保留逻辑应用的窗口和所有权检查。不同接收者必须是同一已聚焦 AX 对象、public owner、精确窗口及 CG owner 所证明的存活、完成启动的 Prohibited 进程。私有符号缺失时保留原接收者；查询失败或身份不符则在投递前拒绝。Command 快捷键保留应用 PID，前台/global 路径不变。不包含仅修改时间戳或绕过认证的诊断变体。

App 字面文本输入在支持时使用 `AXSelectedText`、当前 UTF-16 选区和预期值回读。终端和 ASCII 控制字符保留受保护的按键路径，不支持的目标继续安全拒绝。对于 web 内容，不把 AX-only 回读当作 renderer/DOM 确认。secondary action 除 raw/lowercase 形式外，也接受精确、大小写保留的 advertised 别名；保留 membership 和歧义检查，不增加隐式 AXPress 或像素回退。

## 剪贴板启动握手

只将剪贴板事务的主线程启动等待限制为三秒。排队 callback 与超时等待者通过 mutex 共用可选闭包。超时可以取走并释放尚未开始的工作，防止迟到剪贴板写入。callback 一旦取走工作，就继续等待完成，并保留 mutation/clipboard lease 直到恢复结束。所有权检查与恢复不会在事务中途取消。

对于没有处理 AppKit 主队列的 host，此路径安全拒绝，不安装其他 GUI host、不改变身份、不重放 paste。

## 公开错误与文档

键盘拒绝应推荐受支持的元素/browser 操作，或显式桌面观察与聚焦，不应推荐公开 App schema 不支持的 `delivery_mode` 选项。缺少分发证据时，明确的 `effect: refused` 默认得到 `sent: false`；显式 `sent` 布尔值仍优先，未知 mutation 错误仍保持保守判断。不添加新投递参数或自动重试。

Node REPL 初始说明引导模型在桌面动作前使用 `cua.getState()` 或运行时文档。示例区分数字 ID、按键数组及 JavaScript 执行超时与 app options。

## 验证与待完成的验收

- **Windows 模态/清理：** 公共 Qt 夹具复现了 30.341 秒 click 等待。修后 direct MCP click、SDK click、secondary invoke 在 150/153/149 毫秒返回，并由独立 AX/PNG 确认模态。SDK dispose 等待 pending 清理，25.681 秒后成功。这些是限定主机检查，可选 UIAccess worker 单独验收。
- **Windows 窗口选择：** 修前真实非活动 owned 辅助窗口令正常 624×391/14,212 字节 PNG 变成 2×2/86 字节。修后 direct MCP 和实际 Medium Node REPL/SDK 返回原主窗口 PNG，已核内核实际加载的候选 DLL/NAPI 哈希。后台活动弹窗捕获和单一最小化目标选择也通过。未验收最小化截图及该轮前台选择分支。历史 FX 的 73 字节图像与冻结程序身份缺失，原 case 未验收。
- **macOS 编辑：** 此前自有 TextEdit sheet 上六次单次字符/删除、语义文本、Command 选区与 Escape 检查通过，具备独立精确值/选区、自有窗口像素及进程清理证据。针对此前 PR head 的 macOS 26.6.2 review 发现 Save-sheet 键盘接收方路由不可达。本次合入的 main 改变了窗口身份的祖先解析，但合并后的 Save-sheet 路径尚未复验，验收仍未闭合。不代表 macOS 14/x64/Electron、独立 CLI、JSONExport 或完整 benchmark 一致性。
- **公开拒绝契约：** 两个新增 Rust 测试修前失败、修后通过；实际公开 facade/schema 测试从 2 过/1 失败变为 3 过/0 失败，core 库串行 652 项通过。契约测试不证明原生 GUI 输入效果。

原生测试还覆盖生命周期保留、最终清理失败、剪贴板 callback 取消、进程身份及窗口选择策略。PR 准备同时执行 build、typecheck、版本和打包检查。一次并行 core 运行停在既有 registry 测试中，该结果未计为通过。

明确保留已知限制：Windows App.paste 未实现；SAFER 派生的 Medium host 保留 TokenElevation，可能被现有 app-launch token 策略拒绝；部分 Windows UIA 效果未确认；Mac TimeToLeave 同步读回失败与后续文本匹配的时序未闭合。公司策略终止自编译 Mac 应用不能确定 AP 输入原因。模型图像上下文限制不属于工具修正。

发布验收仍需要每个架构的制品、适用场景下的正常签名/公证、校验和验证安装及最终消费者检查。构建、权限、回执和 benchmark 控制面状态不能替代运行时效果或质量结果。本次不包含权限、安全防护、账号或模型变更。
