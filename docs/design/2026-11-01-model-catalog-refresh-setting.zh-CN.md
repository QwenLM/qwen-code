# 由运维控制的 models.dev 目录刷新

[English](2026-11-01-model-catalog-refresh-setting.md) | [简体中文](2026-11-01-model-catalog-refresh-setting.zh-CN.md)

## 问题

每个会话初始化时都可能启动模型目录刷新，进而每 24 小时访问一次 `models.dev`。当前只能用进程环境变量关闭。托管安装无法保证终端、桌面端和服务端每条启动路径都设置这些变量，而工作区环境值会被有意拒绝。

## 决策

在现有 `model` 设置分组中增加布尔开关 `model.catalogRefresh`，默认值为 `true`。通过加入 `WORKSPACE_RESTRICTED_SETTINGS`，仅允许 User、System 和 SystemDefaults 作用域生效。在构造会话 `Config` 之前完成该运维值的解析，`--bare` 模式同样保留该选择。

CLI 以 `modelCatalogRefreshEnabled` 传给 core。只有该设置不为 `false` 且解析后的使用统计设置为开启时，core 才启动后台刷新。仅读环境变量的门禁保持不变，因此 `QWEN_CODE_MODELS_DEV_REFRESH=off` 仍优先。内置及此前下载的目录继续可用；该开关只控制网络刷新，不控制本地目录读取。

将 `privacy.usageStatisticsEnabled: false` 作为该后台第三方请求的退出方式。与专用设置不同，这一隐私选择已经跨运维作用域并在 `--bare` 模式下保留。两处都要写入文档，避免其中一个看似承诺抑制流量、另一个路径却继续发送。

## 范围与风险

不把设置暴露到设置对话框，不引入三态模式，也不允许工作区设置重新开启刷新。不改变目录查找逻辑，也不改变独立的 `QWEN_CODE_MODELS_DEV=off` 行为。主要兼容性风险是运维者以为隐私退出只会关闭遥测；文档需明确说明该关联，避免歧义。

## 验证

验证 schema 要求重启且默认开启，工作区值会被剥离，所有运维作用域按正常优先级解析，`--bare` 保留选择，CLI 构造只透传布尔值。验证 core 在设置关闭或使用统计退出时都跳过刷新，且环境变量门禁保持有效。同步生成的设置 schema 和中英文设计文档。
