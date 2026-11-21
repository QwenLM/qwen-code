# Web Shell 首条消息的自动标题

[English](web-shell-first-prompt-title.md) | [简体中文](web-shell-first-prompt-title.zh-CN.md)

## 问题

提交首条消息时，Web Shell 会创建 daemon 会话。原先，短消息生成的标题要等
元数据 PATCH 完成后，才会挂接会话并发送消息。标题写入变慢会延长输入框的
准备状态。

## 方案

会话分配后，工作区会话列表可以先显示草稿的临时标题。Web Shell 通过刚分配
的会话客户端在后台发起持久化。[首条消息的会话切换流程](web-shell-first-prompt-navigation.zh-CN.md)
继续使用该会话，即使会话创建完成时用户已经切走。宿主的 `onSessionCreated`
回调与 `/clear` 继承的手动标题沿用现有的准备顺序。

按会话归属路由的元数据 PATCH 使用独立的 `initialDisplayName` 字段。旧版
daemon 或 ACP worker 收不到可能被当作无条件改名的 `displayName`。处理函数
启动 ACP 写入后释放会话租约，持久化继续在后台执行。记录服务将自动标题加入
写入队列之前，会检查在途写入和已有标题。之后收到的显式改名可以通过同一个
记录队列追加标题。

持久化成功后，桥接层更新会话列表版本。只有原会话仍由同一实例持有且在线
会话没有更新的标题时，才发布标题事件。浏览器通过 daemon 事件和会话列表
查询同步标题，延迟返回的 PATCH 响应无法在界面恢复旧标题。

## 验收

- 挂起标题 PATCH，在 Chromium 中确认首条消息先到达 daemon 并收到 HTTP 202，
  随后才释放标题响应。
- 在创建会话期间切换会话，界面保持在用户选中的会话。首条消息只发送一次，
  目标是刚分配的会话。
- 在自动 PATCH 写入前将其挂起，手动改名后再释放 PATCH，确认会话列表和
  持久化标题均保留手动名称。
