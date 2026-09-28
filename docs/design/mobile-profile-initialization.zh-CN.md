# Android 浏览器配置初始化

[English](mobile-profile-initialization.md) | [简体中文](mobile-profile-initialization.zh-CN.md)

## 问题与证据

原有实现假设新的 UUID 名称意味着空白 WebView 存储。在 Android System WebView 124 上，进程可能在提供程序持久化配置注册表之前快速终止。下一次创建的新名称可能取得已经使用过的目录，并暴露旧 localStorage。未修改的父版本 APK 已复现此问题；等待元数据写入会掩盖问题，并非修复。

## 设计

在加密的原生凭据库中，将 `browserInitialized` 标志与浏览器标识一起保存。新连接、修改凭据或地址，以及旧格式迁移均从 false 开始。重命名保留该标志。在创建或加载浏览器配置之前读取提供程序已知名称。若名称丢失，原有 true 标志失效，必须先持久化 false。

未初始化的配置除 `MULTI_PROFILE` 外，还要求 AndroidX WebKit 1.13 的 `DELETE_BROWSING_DATA` 能力。取得该配置专用的 WebStorage，调用 `WebStorageCompat.deleteBrowsingData`。只有完成回调到达并成功持久化 true 后，WebView 才能加载文档或接收凭据。不支持的提供程序、存储失败和初始化失败均显示原生提示，不回退到共享配置。已经初始化且名称仍然存在的配置保留浏览器状态。

进程级集合在异步清除期间保留配置名称，即使 Activity 重建也不释放。在已初始化配置的快速路径之前检查占用。连接开始及清除完成时重新读取原生凭据库，防止其他 Activity 的编辑被覆盖或已删除、已轮换的配置复活。离开初始化页面会使本次 Activity 请求失效。迟到的完成回调释放占用，但不能把已修改或删除的配置标为已初始化，也不能创建 WebView。取消后保持 false，下次重试重新清除。超时不构成加载授权；提供程序卡住时，必须等操作完成后重试或重启进程。

## 范围与取舍

仅修改原生连接、凭据库序列化、固定 AndroidX WebKit 版本、Activity 接线、文档和测试。格式迁移保留原生凭据，但会清除一次现有浏览器会话与缓存。提供程序丢失配置元数据时可能再次清除。这能防止信任残留浏览器数据，不能保证有缺陷的提供程序在进程退出后保留数据。不改变守护进程凭据、H5 令牌存储、其他 Phase 2 切片或主服务器协议。生产保护不使用反射、提供程序私有文件、任意等待或清空应用数据。

## 验证

JVM 测试覆盖旧格式迁移、初始化状态持久化、写入失败、提供程序名称丢失、重命名与标识轮换以及过期标识更新。设备测试覆盖提供程序能力不足时拒绝连接，以及同源 cookie/localStorage 使用前的配置级清除。反复重启进程，不清空应用数据，也不通过等待元数据刷新掩盖故障。旧提供程序必须拒绝不安全连接；支持该能力的提供程序必须先清除再加载，并保留已初始化且已知配置的数据。分别记录准确的提供程序/API 覆盖和不支持的场景。

## 参考与待确认事项

- [WebStorageCompat](https://developer.android.com/reference/androidx/webkit/WebStorageCompat)
- [ProfileStore](https://developer.android.com/reference/androidx/webkit/ProfileStore)

没有公开的同步配置注册表刷新 API。因此该保护依赖文档规定的配置名称查询、配置级浏览数据清除完成回调，以及对实际安装提供程序的测试。生产移动端验收与服务器每设备撤销能力仍是独立工作。
