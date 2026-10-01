# Android WebView 文件选择

[English](mobile-file-selection.md) | [简体中文](mobile-file-selection.zh-CN.md)

状态：Phase 2 后续切片，依赖连接配置（#12121）与初始外壳（#11722）。

## 问题与范围

Web Shell 已通过 HTML 文件输入提供附件、工作区上传和扩展压缩包功能。Android 默认 WebChromeClient 会取消这些请求，因此外壳无法使用现有功能。增加原生文档选择桥接，不重复上传逻辑，也不修改 daemon 路由。相机/麦克风采集、目录、下载和后台任务属于独立改动。

## 设计

仅为当前已附着的 WebView、且页面位于配置的 daemon origin 时处理 `onShowFileChooser`。支持单个及多个文件打开模式。使用 `ACTION_OPEN_DOCUMENT`、`CATEGORY_OPENABLE`、只读访问和请求中的 MIME 提示；未知提示回退为通用文件选择。Web Shell 现有不限制类型的输入必须能选择源代码和文本，不能仅允许图片。采集提示仍使用文档选择器；不支持的保存/目录模式取消。

同时只允许一个未返回的系统选择器。每个回调绑定请求的 WebView/文档。切换配置、主文档导航、连接错误、Activity 销毁时恰好取消一次回调。取消后仍占用在途槽，直到旧系统结果返回，避免迟到结果被交给新请求。重建时只保存“在途”布尔标志，不保存回调、URI 或内容；先丢弃孤立结果，再接受新请求。

将选择器结果视为不可信。只接受带读取授权、来自可解析且 UID 不同于本应用的提供方的 content URI；拒绝 file/网络 URI、不可访问提供方以及混合的不安全结果。单选模式校验结果数量，最多允许 100 个文件，与 H5 工作区上传批次限制一致。绝不把应用私有文件交给 WebView。不持久化 URI 授权、不复制文件、不记录选中 URI、不请求广泛存储/媒体权限。浏览器 content/file 访问设置保持禁用，通过回调交付选中的输入文件。

回调不提供发起请求的 frame 身份，因此顶层 origin 校验不能认证嵌入 frame。安全边界是用户明确选择与受限的 URI 授权。上传能力检查、工作区/会话目标校验、大小限制和服务器授权仍由 H5 负责。Android 将选择绑定到 WebView 文档；同一文档内会话/工作区变化时，H5 已负责轮换/重置输入。

## 文件与决策

一个小型原生选择控制器处理 Intent/结果校验及在途请求生命周期。MainActivity 注册 AndroidX Activity Result 启动器，并转发 WebChromeClient 和生命周期事件。定向设备测试使用真实 Android URI/Intent API 验证控制器；原生验收使用本地合成文档。无需新增生产依赖或 Android 权限。

## 验收与限制

已提交的设备测试使用独立测试 APK 中的提供程序，并以仅测试使用的读取权限保护。
测试验证真实的逐 URI 授权、单选/多选成功回调和所选合成文件的字节，包括恰好
100 个文件的上限。过期文档拒绝测试使用原本能够接受的结果。每次测试后清理
夹具文件和授权，不引入产品提供程序或权限。此 Activity 自行处理配置变化，
仅旋转屏幕不会使其重建；验证在途选择器状态恢复时须明确触发 Activity 重建。

1. 现有单选/多选 HTML 文件输入打开系统文档选择器，只收到用户明确选择且可读的文档。
2. 取消、选择器缺失、格式错误、不安全 URI、不支持模式均只取消一次，不崩溃或遗留挂起回调。
3. 配置/文档变化丢弃旧结果；新请求不能接管尚未返回选择器的回调。重建后不把旧文件交给新页面。
4. 通用文件和压缩包过滤可用，不需要广泛存储权限、相机权限或持久授权。
5. Web Shell 上传路由和 origin 隔离保持不变。Android 运行时验收与编译分别验证；如实报告实际 daemon/TLS 和真机覆盖情况。

## 参考

- [WebChromeClient 文件选择安全约定](<https://developer.android.com/reference/android/webkit/WebChromeClient#onShowFileChooser(android.webkit.WebView,android.webkit.ValueCallback,android.webkit.WebChromeClient.FileChooserParams)>)。
- [Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)。
- [连接配置](mobile-connection-profiles.zh-CN.md)。
