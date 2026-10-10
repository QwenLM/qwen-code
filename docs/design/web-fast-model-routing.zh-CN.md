# Web Shell 快速模型路由

[English](web-fast-model-routing.md) | [简体中文](web-fast-model-routing.zh-CN.md)

## 问题与范围

Web Shell 的快速模型选择器丢弃 ACP 路由 ID，只提交模型名，因此无法按 endpoint 区分同名 provider。重新打开已固定的模型时也丢弃 endpoint，可能选中其他行。本次解决 #12814，不改变顾问咨询行为，也不增加模型配置字段。

## 决策

保留现有模型列表，原样提交列表中的 ACP ID。服务端复用现有 ACP 路由辅助函数解析注册模型，再保存 `authType:id\0<registryBaseUrl>`。所选行没有显式 endpoint 时保留空后缀；Qwen OAuth 仍保存 `authType:id`。

运行中会话保留 `/model --fast` 路径，使运行时配置立即生效。独立设置写入只使用所属 workspace 的设置注册表。legacy-primary 路由使用绑定的 workspace 和信任标记；带 workspace 的路由使用解析并确认信任的 runtime 所属 workspace。两条路径都不加载其他会话的运行时快照，也不回退到 primary runtime。原有裸模型名和带 auth 前缀的选择器保持原来的行为。未知 ACP 路由和运行时快照不写入设置。

回显复用 provider 状态元数据，并在快速模型选择器打开时加载，因为恢复后的会话模型行不含 endpoint 元数据。按模型名、auth 类型和公开 endpoint 将保存的公开选择器与模型行匹配，只选中唯一匹配的行。固定项不存在或脱敏导致歧义时，保持未选中，直到用户主动选择。公开 endpoint 只用于回显，不用于重新构造路由选择器。命令响应仍显示提交的 ACP ID，设置响应复用现有选择器脱敏函数。

## 约束与后续

本次不向现有 ACP 列表增加 fast-only 模型。含凭证 endpoint 的 workspace 保存策略仍由 #12856 及其已有后续 PR 统一处理。公开值无法区分仅隐藏凭证不同的 endpoint，也无法在多个同名路由中识别隐式 endpoint，因此这类回显有意保持未选中。

## 验收

- 在两个同名 endpoint 中选择第二个时保存对应 endpoint，运行中会话无需重启即可生效。
- 重新打开选择器仍选中同一行；未知或歧义固定项不能因按 Enter 被静默替换。
- User 和 Workspace 选择保留各自范围，包括独立设置写入。
- 无效 ACP 路由不写设置，原始 endpoint 凭证不进入命令消息或设置响应。
- 使用定向服务端与 UI 回归、build、typecheck 和浏览器修复前后证据验证。浏览器 mock daemon 验证 UI 和请求；服务端测试验证私有选择器保存与运行时更新。
