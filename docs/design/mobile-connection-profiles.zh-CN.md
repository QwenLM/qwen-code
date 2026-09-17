# Android 连接配置与受保护的凭据

[English](mobile-connection-profiles.md) | [简体中文](mobile-connection-profiles.zh-CN.md)

状态：Phase 2 提案与实现，延续 #11704，依赖 #11722。在维护者为 daemon 主监听器提供逐设备可撤销凭据之前，本应用仍是开发客户端。

## 问题

开发外壳从 `qwen_profiles` 读取一个 URL 和可选的明文 token，配置它需要编辑私有偏好文件。目前没有受支持的切换 daemon 或恢复丢失凭据的方式。多个配置复用同一个 WebView 还可能复用上一个连接的 sessionStorage、Cookie 和工作区缓存；同源但凭据不同的配置也存在这种问题。

## 范围

新增原生配置创建、编辑、选择、删除，Keystore 保护的存储，开发配置迁移，以及浏览器状态隔离。会话界面仍由 daemon 提供的 Web Shell 负责，它自行检查 REST 能力。本改动不引入原生聊天界面、原生工作区缓存、后台服务、新协议或逐设备撤销端点。后续原生连接必须自行协商能力，不能沿用其他配置的结果。

## 存储与迁移

每个配置包含随机稳定 ID、显示名称、通过校验的 daemon origin 和可选 bearer token。原生配置数据整体序列化，使用 Android Keystore 生成的密钥进行 AES-256-GCM 加密；每次写入采用加密提供方生成的新 IV，并认证格式上下文。加密 vault 位于 `noBackupFilesDir`，通过 `AtomicFile` 替换，元数据也被加密。密钥缺失或密文无效时拒绝连接；读取时绝不自动生成替代密钥，也不回退到明文配置。

不存在 vault 时，一次性导入有效的旧偏好。提交前先确认加密往返成功，持久化成功后才删除旧 URL/token。每次成功读取 vault 时也重试清除旧偏好，以覆盖两次写入之间被终止的情况。写入失败保留旧数据；清理失败阻止连接并提供重试。无效旧数据保留以便修正，而非静默丢弃。无法读取 vault 时，恢复必须经过明确确认并重置连接数据；无法恢复已失效的 Keystore 密钥。

原生保存的凭据位于 vault，不写入日志；token 输入框禁用视图状态和自动填充持久化；备份及设备迁移排除应用偏好和 WebView 数据。凭据通过现有 fragment 引导交给可信 Web Shell，H5 继续使用其现有的每标签页 sessionStorage。Chromium 不保证 sessionStorage 仅存在于内存，因此本改动不宣称所有 WebView token 副本都被加密。明确的仅内存 H5 认证协议属于独立工作；被攻陷的 daemon 或 root 设备也可访问正在使用的 bearer。

## 配置界面与隔离

原生首页列出配置并提供添加、连接、编辑和删除。拒绝空名称及无效根地址。重命名保持稳定 ID。修改 origin 必须重新输入凭据，不能把 token 自动带到另一个服务器。修改 origin 或凭据时轮换浏览器配置标识，避免旧 Cookie 和本地状态认证新的连接；该标识与配置一起保存。

每次连接创建全新 WebView，在导航前设置 AndroidX 命名 profile，并保留现有 origin 策略。命名 profile 隔离 Cookie、Web 存储和 service worker 数据，同源连接也互相隔离。切换时先销毁旧 WebView 并取消待处理的 JS 确认，再创建新视图；回调确认对应 WebView 仍是当前视图。跨配置不复用 WebView 实例或恢复其保存状态。

此功能需要现有 AndroidX WebKit 依赖提供的 `WebViewFeature.MULTI_PROFILE`。若提供方不支持，仍可管理配置，但连接时显示原生更新提示。Web Shell 的浏览器版本下限仍是 111；Android 连接功能另外要求该提供方能力。不会回退到共享浏览器存储。删除/编辑后，在提供方允许时清理废弃命名 profile；ID 永不复用。Keystore 加密不能替代服务器撤销。

## 文件与依赖

生产代码改动限定在 `packages/mobile-shell`：vault/加密及配置管理类、`MainActivity`、资源、备份规则和定向测试。现有 Gradle、Kotlin、生产 AndroidX 版本保持固定；设备测试新增固定版本的 AndroidX 测试依赖。移动端 CI 在 API 26 和 35 上运行设备测试，并要求 API 35 通道必须支持配置隔离。英中设计文档与包 README 说明实际行为和能力门槛。

## 验收

1. 全新安装直接显示原生配置，不需要编辑私有文件。添加/编辑/删除在重启后保留，token 输入框不展示已保存的密钥。
2. 迁移保留有效连接，仅在持久化成功后删除旧 token，可安全重试中断操作。
3. 密文损坏、密钥缺失、存储写入失败时提供恢复，不进行未认证连接或静默丢失数据。
4. 同 origin 两个配置的 Cookie/localStorage 相互隔离，token 不串用。切换忽略旧回调，凭据修改使用新浏览器 profile。
5. WebView 缺失或过旧时显示原生提示。不支持 MULTI_PROFILE 时不使用共享存储回退连接。
6. 原有 origin 校验、JS 确认、重试、返回导航与 renderer 清理继续有效。

JVM 测试覆盖序列化、迁移/故障路径和认证加密；Android instrumentation 验证真实 Keystore，并在提供方支持时验证 profile 隔离。不支持的场景记为跳过而非通过。使用合成凭据和本地 fixture，无需模型调用。真机、TLS、备份验收必须明确记录，不能由构建成功推断。

## 参考与待决事项

- [维护者架构决策](https://github.com/QwenLM/qwen-code/issues/11704#issuecomment-5645279859)。
- [AndroidX 命名 profile](<https://developer.android.com/reference/androidx/webkit/WebViewCompat#setProfile(android.webkit.WebView,java.lang.String)>)。
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)。

官方发布/签名以及服务器凭据发放/撤销协议仍由维护者决定。后台通知、文件/媒体回调属于独立的 Phase 2 改动。
