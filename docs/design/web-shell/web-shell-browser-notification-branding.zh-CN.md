# 浏览器通知品牌配置

[English](web-shell-browser-notification-branding.md) | [简体中文](web-shell-browser-notification-branding.zh-CN.md)

## 问题与范围

浏览器通知目前固定使用 QwenCode 名称和随包图标。嵌入 Web Shell 的宿主需要传入自己的应用名称和图片 URL，包括 HTTPS CDN 地址。本次只调整通知品牌，不修改侧边栏品牌或浏览器控制的站点来源。

## 配置与接入

在 WebShellWithProviders 及其 StandaloneWebShell 别名上提供 `browserNotifications?: WebShellBrowserNotificationsOptions`。配置包含可选字符串 appName 和 iconUrl，以及默认值为 false 的可选布尔值 defaultEnabled。名称和图标缺失或仅含空白时分别回退到 QwenCode 和随包 PNG。标题保持“应用名称 · 会话标题”，没有会话标题时只显示应用名称。图片 URL 去掉首尾空白后直接传给 Notification.icon，不增加代理、预加载、认证请求头或自动重试。浏览器按自身安全策略获取图片，自定义图片加载失败不保证自动显示默认图标。

不传配置时保留嵌入入口原有行为，不自动接入浏览器通知。传入对象（包括空对象）时，在 daemon session provider 上方接入通知 provider，并展示已有的 UI 设置。浏览器本地偏好仅在没有保存选择时使用 defaultEnabled。已保存的 true 或 false 始终优先，刷新后也保留；删除保存值时恢复该实例的初始默认值。挂载后修改 defaultEnabled 不覆盖当前选择。即使默认开启，也不自动申请浏览器权限。修改品牌配置时保留已挂载会话和通知偏好。内置 main.tsx 显式传入 defaultEnabled 为 true，并继续使用默认名称和图标。因此内置开发页面和安装后的 qwen serve 页面在新的浏览器站点上默认开启，但实际通知仍需要浏览器授权，并符合已有后台或失焦条件。

低层 WebShell 组件不增加该属性：它的 daemon providers 由调用方管理且在组件子树之外，内部通知组件无法观察那些事件。不增加 CLI 参数、daemon 设置、公共 daemon 协议或低层通知 provider API。iframe 和服务端渲染路径继续不使用浏览器通知。

通知状态和摘要标签跟随 App 实际使用的界面语言，包括设置中的语言修改。通过已有内部设置 context 同步语言，不增加第二套语言选择规则。

## 点击归属

每个已挂载的通知 provider 拥有内部 EventTarget，通过 React context 与其后代 App 共享。通知点击使用该 target，替代 window 全局广播，因此只有所属 Web Shell 会导航。已有 window qwen:open-session 事件继续服务 Markdown 链接。通知目标与 App 当前锁定工作区冲突时会被忽略，包括宿主修改锁定工作区后点击旧通知。所属实例卸载后，旧目标不再有活动导航监听。

## 验证

测试覆盖公开入口 provider 层级、传入与省略配置、默认及部分/空白配置、CDN URL 传递、更新配置不重新挂载、权限与关闭偏好保持、实例间通知导航隔离、锁定工作区拒绝及现有独立页面导航路径。组件库构建必须在发布产物中包含默认图片。浏览器验证使用导入公开入口的宿主 fixture，传入自定义品牌并执行真实 daemon 回合；API 采集验证名称、提问/回复及图片 URL，不代表 OS 图标位置或远端 CDN 可用性已验证。已有用户预览服务保持运行。
