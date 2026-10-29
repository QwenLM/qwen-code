# Web Shell 宿主目录选择器

[English](web-shell-host-directory-picker.md) | [简体中文](web-shell-host-directory-picker.zh-CN.md)

状态：[#15186](https://github.com/QwenLM/qwen-code/issues/15186) 的实现提案。下文的 API 形态与优先级是本轮实现选择，待维护者评审；issue 讨论尚未批准最终公开契约。

## 问题与现有行为

嵌入应用可能已有面向其 headless daemon 的目录浏览器。Web Shell 内部的 Add Workspace 对话框接受选择器，但公开组件不能传入宿主选择器。现有接线仅在目标是已连接 daemon、声明 `native_directory_picker` 且满足同源条件时使用 daemon 的原生选择器。在 headless 主机上隐藏该选择器是预期行为。

[独立应用已经可以浏览远程目录](remote-web-shell-daemon.zh-CN.md)。该浏览器与复用嵌入应用自己的 UI 是不同需求。宿主也可以在外部选择目录并调用公开工作区动作，但需要自行协调注册、能力刷新和选中。

## 公开 API 与优先级

在 `WebShellProps` 顶层添加可选的 `onPickWorkspaceDirectory` prop，`WebShellWithProviders` 同样接受它。公开导出的类型为 `WebShellWorkspaceDirectoryPicker`，签名为 `(opts?: { signal?: AbortSignal }) => Promise<string | undefined>`。选项对象遵循已有取消参数惯例。宿主返回当前已连接 daemon 文件系统中一个已存在目录的绝对路径；用户取消时返回 `undefined`。浏览器本机的目录句柄不满足此契约。

复用现有 Browse 按钮。配置宿主回调时优先使用宿主选择器。返回 `undefined`、取消或抛错均不会回退到原生选择器。未配置回调时，保留已有原生能力、目标和同源检查以及手动输入路径的行为。不增加优先级配置或第二个选择器按钮。

宿主回调仅可用于与当前连接 daemon 一致的选中目标，并要求 `workspace.status === 'connected'`。状态不满足时不显示 Browse；已配置宿主回调时也不会回退到原生选择器。该回调不要求 `native_directory_picker` 或页面同源，因此经过认证的跨源嵌入也可以使用。在独立应用的 Folder source 控件中选择另一台计算机时，不得调用当前连接 daemon 的宿主回调。宿主拥有自己的目录浏览器，必须将它绑定到提供给 Web Shell 的同一个 daemon。

选中路径只回填现有对话框，用户仍需点击 Add 才会注册。现有注册验证、持久化能力检查、刷新、选中、错误处理和工作区 trust 语义继续生效。选择路径不会注册工作区，也不会授予信任。选择进行中时禁用 Add，并由提交处理函数拒绝提交，防止选择器尚在选取替代路径时注册原有路径。

Git URL 来源的父目录 Browse 操作复用同一选择器。宿主仍返回已存在的目录；对话框将该父目录与从 URL 推导的仓库名组合，回填克隆目标路径。选择目录不会开始克隆或注册。现有 Git 克隆流程仍需单独提交，其目标验证和 trust 语义保持不变。

## 调用生命周期

每次选择拥有独立的 `AbortController`，并绑定调用时的目标与连接身份。daemon client 实例标识其 base URL、凭据和传输；对话框还跟踪选中的位置和连接状态。关闭、卸载、目标或连接变化、宿主与原生选择方式切换、本地目录与 Git URL 来源切换、后续选择替换当前请求时，旧调用失效并触发 signal 的 abort。选择方式切换时，即使仍有选择器可用，也会取消旧调用。宿主应使用该 signal 关闭选择器 UI，并取消相关请求。本地目录选择与 Git 父目录选择共用此生命周期、忙碌状态和焦点交接。

对话框还会在应用结果或错误、清除忙碌状态之前检查调用身份。即使宿主忽略 abort，迟到的 resolve 或 reject 也不能覆盖新选择、改变当前路径、显示过期错误或清除另一个调用的忙碌状态。用户通过 `undefined` 或 `AbortError` 取消后，对话框仍可继续使用；其他失败沿用现有选择器错误提示。

普通渲染中重建内联回调不代表 daemon 连接变化，不会取消正在进行的选择。下一次选择使用最新回调。目标与连接变化独立于回调引用身份跟踪。

宿主可能在 Web Shell portal 之外渲染选择器。模态的 Add Workspace 对话框会阻止指针和焦点访问该 UI。仅在宿主选择器进行中，Add Workspace 临时变为非模态；完成或取消后恢复模态。宿主负责自身选择器的可访问性、焦点管理与层叠顺序。`DialogShell` 的 `modal` 默认值仍为 `true`，原生选择器路径保留模态行为。这是内部交互移交，不新增公开对话框配置。

切换 Radix 模态模式仍会重新挂载对话框内容，不保留 DOM 节点身份。浏览器观测确认这些重挂会重播入场动画；交接期间的动画抑制暂缓处理。`DialogShell` 通过 body ref 保存并恢复正文的滚动偏移。宿主选择进行中，已接管焦点的宿主 UI 优先；否则，经兼容 shadow root 的 `isFocusUnclaimed` 检查后，将焦点停放在 Add 面板。完成或取消后，使用 `preventScroll` 将焦点返回新挂载的 Browse 按钮；按钮不可用时返回面板。选择期间面板设置 `aria-busy`，Browse 显示“正在选择目录…”。

任一选择器进行中时，目录导航被锁定，建议组合框保持折叠。在目录浏览模式中，不可交互的占位区域保留隐藏列表的高度，避免正文缩短后滚动偏移被截断。选择器保存列表自身的滚动位置，仅在恢复相同建议结果时应用；新选中目录的列表从顶部开始。

若同时打开另一个 `DialogShell`，下层对话框恢复模态时，Radix 层级及 `aria-hidden` 排序仍可能不正确，此情况尚未解决。传统滚动条引起的水平布局偏移尚未验证。

Escape 保留 Add Workspace 现有的关闭行为：`DialogShell` 在 document 捕获阶段处理它，早于外部宿主选择器的普通冒泡处理器，关闭 Add 并取消选择器。宿主选择器中的显式 Cancel 操作可以返回 `undefined`，保留 Add 对话框。只取消宿主选择器的独立 Escape 归属仍待评审，本次不包含该行为。

同一套迟到结果保护也覆盖原生路径，但本提案不扩展 daemon action、SDK 或后端取消契约。客户端使请求失效不保证关闭服务端的原生 OS 对话框。原生请求超时与服务端行为保持不变。

## 实施范围

- `packages/web-shell/client/App.tsx`：公开 prop、宿主优先接线，以及传给对话框的目标/连接身份。
- `packages/web-shell/client/components/dialogs/AddWorkspaceDialog.tsx`：使用选项对象的内部回调、取消、调用归属检查、提交保护、忙碌提示和临时宿主 UI 交接。
- `packages/web-shell/client/components/dialogs/DialogShell.tsx`：默认值为 `true` 的内部模态选项、正文滚动恢复，以及模态切换时的焦点交接。
- `packages/web-shell/client/customization.tsx` 和 `index.tsx`：定义并公开导出 `WebShellWorkspaceDirectoryPicker`；两个公开组件保持现有传参路径。
- 公开入口与对话框测试、`packages/web-shell/README.md` 和本中英文设计文档。

不包含整个对话框替换 API、目录创建 API、新后端文件系统端点、工作区政策扩展、Managed Agent 选择器改造或开放独立应用浏览模式。Git 克隆执行仍由现有克隆流程负责。

## 验证与验收

实现前添加行为测试，确认它们在基线上失败。通过公开组件入口和真实对话框交互，验证 headless 与跨源连接上的宿主选择、宿主优先于原生、取消/错误或失去 connected 状态时不回退、回填路径但不注册，以及正常 Add 流程。对于 Git URL，验证选择已存在的父目录后仅回填推导出的克隆目标，不启动克隆或注册。保留原生能力/同源检查和注册、持久化、trust 语义的覆盖。

验证用户取消、真实失败、重复选择、关闭、卸载、目标和连接变化、普通回调重渲染，以及忽略 abort 的宿主迟到 resolve/reject。断言可见的路径、错误、忙碌状态和注册副作用，而非只检查 prop 转发或回调次数。确认选择进行中时按钮提交与表单提交均被阻止，切换宿主/原生选择方式后旧结果失效。

在真实浏览器中操作位于 Web Shell portal 外的宿主选择器，验证键盘与指针可用、选择和取消后焦点返回 Browse，以及模态行为恢复。同时覆盖没有浏览器 UI 的 pending 宿主、可见忙碌状态和已滚动正文的偏移保持。仅宿主 UI 交互用例标记 `@smoke`，其余浏览器用例不加入该筛选。执行受影响测试、构建、类型检查、lint、preflight 和适用的浏览器交互检查；实际结果与环境限制另行记录，不把本验收计划当作已完成验证。

## 待评审决策

顶层 prop、选项对象签名和宿主优先的单按钮行为，使本次改动范围小且便于调整。维护者仍可在评审时修改名称、位置和优先级。完整取消原生选择器请求及进程需要独立的端到端分析；仅添加 signal 参数不能证明这一保证。
