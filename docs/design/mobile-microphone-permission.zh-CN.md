# Android 麦克风权限

[English](mobile-microphone-permission.md) | [简体中文](mobile-microphone-permission.zh-CN.md)

## 问题与现状

Web Shell 已通过 `getUserMedia` 采集麦克风音频、转换为 PCM，并经认证的语音 WebSocket 发送。原生外壳目前拒绝 WebView 权限请求，也未声明录音权限。Qwen Live 也通过 `live/useLiveBrowserHost.ts` 的浏览器 `getUserMedia` 使用 `/live/web` 音频路径。本切片启用这两条已有采集路径，不另建录音器或转录服务，基于已隔离连接配置的开发外壳。

## 设计

仅当前已挂载 WebView、配置 daemon origin 发出的纯 `RESOURCE_AUDIO_CAPTURE` 请求可被接受。请求 origin 与顶层页面 origin 均须匹配配置。支持 HTTPS 和明确允许的回环 HTTP origin，不增加 TLS 例外。相机、音视频混合及未知资源直接拒绝，不弹 Android 权限提示。

原生对话框显示连接 origin，让用户明确启用麦克风。即使应用已有 Android 录音权限也需要该操作。确认后，如有必要，通过 Activity Result API 请求 `RECORD_AUDIO`。授予纯音频采集前再次检查当前视图、origin、可见生命周期与系统权限。系统拒绝不影响文本使用。启动应用时不申请权限。

单个待处理请求拥有确认对话框及未返回的系统结果。导航、连接错误、进入后台、切换配置及销毁取消待处理请求。已取消的系统请求继续占有结果槽，直到系统返回；新文档不能接管旧结果。Activity 重建只保存在途标志，不保存 WebView 请求。WebView 取消时隐藏对话框，不再次响应已取消请求。

WebView 授权可持续到视图销毁，原生 API 无法可靠报告单个音轨何时停止。因此，获得麦克风权限的连接会在 Activity 停止时关闭。原生 UI 在同意前解释此行为，之后提供手动重新连接。该规则适用于听写和 Qwen Live 浏览器音频，包括进行中的 Live 通话；即使听写已结束或打开另一个全屏 Activity 也仍生效。返回应用不会自动恢复 Live 通话；未发送的页面状态可能丢失。仅文本连接不受影响。这是开发客户端明确采用的权衡，避免此切片启用后台采集，不增加后台录音器或前台服务。后续可通过 H5/原生协作的采集生命周期改善。

系统文件打开/保存需要启动前检查，否则选择器会停止 Activity，并在页面收到结果前销毁页面。对于已授权麦克风的连接，Activity 在启动前拦截 `ACTION_OPEN_DOCUMENT` 和 `ACTION_CREATE_DOCUMENT`，异步向原 launcher 返回正常取消结果。随后提供 **Keep editing（继续编辑）**，保留当前页面；或 **Reconnect（重新连接）**，明确放弃临时页面状态并停止麦克风访问。用户重连后重新发起文件操作。被拦截的请求不会创建目标文件。保护逻辑位于麦克风切片的 Activity，独立文件选择和下载切片无需包含彼此实现即可使用。不恢复已取消的文件操作，也不宣称麦克风与文件已无缝协作。

API36/WebView134 原生 AppOps 诊断观察到录音从活动到非活动的转换、克隆音轨行为，以及重复 `getUserMedia` 再次请求原生同意。但 app-op 非活动状态并非文档保证的 WebView 采集权限永久撤销，因此本补丁不据此放宽后台销毁规则。

## 组件与范围

manifest 声明录音权限、Chromium 音频输入需要的普通 MODIFY_AUDIO_SETTINGS 权限，并将麦克风硬件标为可选。`NativeMicrophonePermission.kt` 管理请求/结果状态；`MainActivity.kt` 管理显示 origin 的确认 UI、系统权限 launcher 和视图生命周期。字符串、移动 README 与设备测试说明并验证行为。已有 H5 语音认证、能力检查、安全上下文规则、音频处理及 owner 变化清理仍是权威实现。不新增 daemon 路由、JavaScript 桥、音频存储或依赖。

这是开发客户端的权限集成，不代表批准正式移动发布。真机音频质量、转录准确性、后台语音及服务端逐设备凭据撤销不在范围内。

## 验证与验收

- 在前置 APK 上确认真实 WebChromeClient 拒绝音频请求。
- 构建 debug/release，运行已有 JVM/存储/profile 测试、lint 和权限状态设备测试。
- 检查原生拒绝、系统拒绝和授予、已有系统权限、错误 origin、未知/混合资源及并发请求。
- 确认已取消或恢复的系统结果不能授权替代请求；导航和销毁使待处理确认失效。
- 在支持的模拟器上，通过合成本地页面激活真实 `getUserMedia`，接受/拒绝原生与系统对话框，仅同意后出现活动音轨。不需要主机麦克风输入或真实语音。
- 针对已配置的 daemon，分别验证听写与 Qwen Live 浏览器音频：接受/拒绝同意、将活动采集转入后台，并确认返回后需要明确重连且不会自动恢复 Live 通话。这些属于 daemon/设备验收，不能以权限控制器测试代替。
- 将启用麦克风的连接转入后台，确认 WebView 销毁并显示手动重连 UI；仅文本连接应保留。记录设备/provider 版本及实际缺口，不声称验证了真机或 daemon。
- 在组合文件选择/下载构建中，原生麦克风同意后尝试打开和保存。确认不会打开系统选择器，请求恰好取消一次，继续编辑保留相同页面/草稿，第二次请求不会被永久占用。明确重连后重试打开/保存并核对真实字节；被拦截的保存不应创建空文件。将活动录音页面切到后台，确认原有销毁机制仍有效。

## 待办事项

合入前请维护者审阅明确的进入后台即关闭连接的权衡。页面/语音状态保留另行设计，并在正式移动发布前测试真实 HTTPS daemon 和物理设备。逐设备可撤销的守护进程凭据仍是需要维护者提供的前提。

## 参考

- [Android PermissionRequest](https://developer.android.com/reference/android/webkit/PermissionRequest)
- [运行时权限流程](https://developer.android.com/training/permissions/requesting)
