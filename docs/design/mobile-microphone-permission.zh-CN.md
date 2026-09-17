# Android 麦克风权限

[English](mobile-microphone-permission.md) | [简体中文](mobile-microphone-permission.zh-CN.md)

## 问题与现状

Web Shell 已通过 `getUserMedia` 采集麦克风音频、转换为 PCM，并经认证的语音 WebSocket 发送。原生外壳目前拒绝 WebView 权限请求，也未声明录音权限。本切片启用已有路径，不另建录音器或转录服务，基于已隔离连接配置的开发外壳。

## 设计

仅当前已挂载 WebView、配置 daemon origin 发出的纯 `RESOURCE_AUDIO_CAPTURE` 请求可被接受。请求 origin 与顶层页面 origin 均须匹配配置。支持 HTTPS 和明确允许的回环 HTTP origin，不增加 TLS 例外。相机、音视频混合及未知资源直接拒绝，不弹 Android 权限提示。

原生对话框显示连接 origin，让用户明确启用麦克风。即使应用已有 Android 录音权限也需要该操作。确认后，如有必要，通过 Activity Result API 请求 `RECORD_AUDIO`。授予纯音频采集前再次检查当前视图、origin、可见生命周期与系统权限。系统拒绝不影响文本使用。启动应用时不申请权限。

单个待处理请求拥有确认对话框及未返回的系统结果。导航、连接错误、进入后台、切换配置及销毁取消待处理请求。已取消的系统请求继续占有结果槽，直到系统返回；新文档不能接管旧结果。Activity 重建只保存在途标志，不保存 WebView 请求。WebView 取消时隐藏对话框，不再次响应已取消请求。

WebView 授权可持续到视图销毁，原生 API 无法可靠报告单个音轨何时停止。因此，获得麦克风权限的连接会在 Activity 停止时关闭。原生 UI 在同意前解释此行为，之后提供手动重新连接。即使听写已结束或打开另一个全屏 Activity（包括文件选择器），该规则仍生效；未发送的页面状态可能丢失。仅文本连接不受影响。这是开发客户端明确采用的权衡，避免此切片启用后台采集，不增加后台录音器或前台服务。后续可通过 H5/原生协作的采集生命周期改善。

## 组件与范围

manifest 声明录音权限、Chromium 音频输入需要的普通 MODIFY_AUDIO_SETTINGS 权限，并将麦克风硬件标为可选。`NativeMicrophonePermission.kt` 管理请求/结果状态；`MainActivity.kt` 管理显示 origin 的确认 UI、系统权限 launcher 和视图生命周期。字符串、移动 README 与设备测试说明并验证行为。已有 H5 语音认证、能力检查、安全上下文规则、音频处理及 owner 变化清理仍是权威实现。不新增 daemon 路由、JavaScript 桥、音频存储或依赖。

这是开发客户端的权限集成，不代表批准正式移动发布。真机音频质量、转录准确性、后台语音及服务端设备凭据撤销不在范围内。

## 验证与验收

- 在前置 APK 上确认真实 WebChromeClient 拒绝音频请求。
- 构建 debug/release，运行已有 JVM/存储/profile 测试、lint 和权限状态设备测试。
- 检查原生拒绝、系统拒绝和授予、已有系统权限、错误 origin、未知/混合资源及并发请求。
- 确认已取消或恢复的系统结果不能授权替代请求；导航和销毁使待处理确认失效。
- 在支持的模拟器上，通过合成本地页面激活真实 `getUserMedia`，接受/拒绝原生与系统对话框，仅同意后出现活动音轨。不需要主机麦克风输入或真实语音。
- 将启用麦克风的连接转入后台，确认 WebView 销毁并显示手动重连 UI；仅文本连接应保留。记录设备/provider 版本及实际缺口，不声称验证了真机或 daemon。

## 待办事项

合入前请维护者审阅明确的进入后台即关闭连接的权衡。页面/语音状态保留另行设计，并在正式移动发布前测试真实 HTTPS daemon 和物理设备。服务端设备凭据仍由维护者提供。

## 参考

- [Android PermissionRequest](https://developer.android.com/reference/android/webkit/PermissionRequest)
- [运行时权限流程](https://developer.android.com/training/permissions/requesting)
