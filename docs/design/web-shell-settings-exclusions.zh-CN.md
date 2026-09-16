# 嵌入式设置条目排除

[English](web-shell-settings-exclusions.md) | [简体中文](web-shell-settings-exclusions.zh-CN.md)

## 问题与范围

原生设置页有硬编码排除规则，但没有宿主展示选项；模型管理卡片依赖普通 Model 描述符。本设计用一个 PR 实现 #11949 收敛后的范围：条目排除、精选稳定 ID、独立模型管理。不增加白名单、分类/作用域策略、字段覆盖、条目深链或升级校验器。

## 设计

导出 WebShellSettingsOptions，包含可选 readonly excludeItems 列表，同时导出 WebShellSettingItemId 联合类型与 WEB_SHELL_SETTING_ITEM_IDS。精选别名显式映射到配置 key；映射为内部实现，schema 改名时别名保持稳定。builtin 覆盖聊天宽度、浏览器通知、Live 设置、本地控制和模型管理。未知运行时 ID 不匹配任何项。省略选项或空列表保持既有行为。

先构建原始设置分类，再过滤全部条目并移除空分类。模型管理作为独立条目加入 Model，保持独立卡片；存在普通 Model 行时保留原有行数计数，仅模型管理存在时计数为一。原生能力与硬编码排除始终生效。浏览器通知不依赖聊天宽度是否显示。分类导航回退到剩余分类，全空使用既有空状态。

通过 App 和公开 provider 包装器透传选项。设置页启动的嵌套选择器在来源项被排除时关闭；命令启动的模型选择器仍可用。排除不修改配置、后端权限或设置页之外的模型增删操作。

## 文件与兼容性

修改限于 web-shell 包：client/settings.ts、App.tsx、index.tsx、SettingsMessage.tsx、定向测试及嵌入文档。无 daemon 协议变更。两个作用域及既有视觉样式保持不变。设置别名手动维护；新增 schema 设置默认显示，直到其受支持别名被显式排除。

## 验证

测试默认/空列表等价、两个作用域中的普通项排除、builtin 独立性、空分类与初始分类回退、所有普通 Model 项排除后的模型列表与切换、模型区排除以及设置弹框的动态排除。在桌面和移动视口运行浏览器 fixture，再执行构建/类型检查、定向测试、完整 preflight 和两轮干净自审。主仓库集成另验证 runtime、Console、Extension、真实模型交互及便携生产包。

## 决策与状态

已在本地实现，2026-09-16。定向测试与桌面/移动端浏览器检查通过，完整验证待完成。本次收敛范围不依赖 #6974 的作用域策略改动。

## 浏览器证据

隔离 fixture 使用模拟模型，展示默认界面、排除普通模型字段及移动端布局。已验证模型选择回调；这些截图不代表真实模型服务调用。

![Default](assets/settings-exclusions/default.png)

![Excluded](assets/settings-exclusions/excluded.png)

![Mobile](assets/settings-exclusions/mobile.png)
