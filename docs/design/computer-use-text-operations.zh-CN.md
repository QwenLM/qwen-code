# Computer Use 平台说明与文本操作

[English](computer-use-text-operations.md) | [简体中文](computer-use-text-operations.zh-CN.md)

Computer Use SDK 在 macOS 上提供面向 App 的观察与输入。Windows、Linux 保留精确窗口工作流。唯一的内置 Skill 入口根据所连接 driver 的工具清单选择两份平台文档之一。这是目标端元数据，不是 Node 主机的操作系统。CLI 和 SDK 发行物必须携带相同入口和资源。

## 公开 API

`computer.getPlatform()` 通过现有 owner 的 `listToolsJson()` 通道返回 `macos`、`windows` 或 `linux`。缺失或非法元数据明确失败，无需观察桌面。

macOS 上，`app.paste(text, { format: 'text' | 'md' | 'html' })` 向 App 当前窗口粘贴，format 默认 `text`。`app.selectText(element, text, { prefix, suffix, selection })` 在已观察元素中选择唯一匹配；selection 默认 `text`，另有 `cursor_before` 和 `cursor_after`。App 句柄保留现有串行执行、当前窗口解析、短 ID 校验和内部投递管理。精确窗口 SDK 方法、强类型 driver/session 方法携带相同操作。原生工具契约只声明支持 macOS；Windows/Linux 说明不暴露这两个方法。

## 原生行为

参考是已安装的官方 SkyComputerUseService，SHA-256 为 `25e9141499b94c396f39afbdb7b19ed8f49e45dc8c61be61028ceab8f3807ce6`。反汇编定位到 `ComputerUseAppController.selectText`（`0x100077cf4`）、`sourceTextRange`（`0x10072e0a0`）和支持重叠、上下文约束的唯一匹配搜索（`0x10072e338`）。本地详细证据保留在 `.qwen/e2e-tests/paste-select/`。

选择首先检查被保留的精确 AX 元素是否支持可写 `AXSelectedTextRange`。它将可见格式文本映射为原文偏移，找不到时回退到元素纯文本。匹配区分大小写、计入重叠出现、要求可选 prefix/suffix 紧邻目标，只接受一个结果。AX 范围使用 UTF-16 偏移。光标定位将范围变为相应边界上的零长度选区。设置选区前在必要时聚焦字段；AX 写入失败会传递错误，不使用键盘重放选择。读回决定动作效果是否可确认。

粘贴是进程内串行的剪贴板事务，以及一次定向 Command-V 投递。事务保存所有可读剪贴板 item/type、惰性提供数据、等待读取及有时限的 AX 效果证据，并仅在仍拥有剪贴板 change count 时恢复快照。外部剪贴板改动必须保留。HTML 与 Markdown 通过进程内 AppKit 转换提供 HTML、RTF、纯文本，禁止外部资源加载。Markdown 使用 pulldown-cmark 转换，不引入可执行程序或服务。剪贴板和富文本转换在 AppKit 主线程运行，输入 worker 持有队列及修改所有权直到清理完成。取消、错误路径必须安全释放剪贴板所有权；投递成功不等于应用已插入内容。

两个动作使用现有精确窗口门禁及 App 焦点、输入基础设施。工具注册接入现有桌面输入授权适配器、进程目标保护、capture scope 和 origin-manifest 限制。不在后台失败后于前台重放，不增加权限所有者或运行时进程。

普通 Node 不运行 AppKit 主事件循环。现有 Node addon 提供私有同步主循环 pump；Node SDK 的强类型 paste 和通用工具调用均只在原生 paste Promise 未完成期间调用它。pump 在 Node 主线程运行，Worker 线程使用会在投递前被拒绝，并在原生清理完成后停止。调用前已取消的 signal 会阻止进入原生方法；原生调用开始后的取消则等待调用及剪贴板清理完成。Node 包以外的原生宿主必须像 AppKit 应用或 driver 服务一样提供 AppKit 主事件循环。

## 验证

测试唯一、歧义、缺失匹配，紧邻上下文、重叠匹配、UTF-16 范围、格式文本映射和全部选择模式。测试剪贴板格式转换、item/type 保留、外部修改保护、串行及失败清理。验证生成的强类型导出、facade/App 投递、平台元数据路由、文档打包及安装后资源路径。最后使用本机自有 TextEdit/LibreOffice 文档，选择、粘贴替换并独立验证文本、格式及剪贴板恢复，不操作基准机器。更新现有 PR 前完成 build、typecheck、定向测试与自审。
