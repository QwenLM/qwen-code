# Browser Use 的 profile 归属

[English](browser-use-profile-ownership.md) | [简体中文](browser-use-profile-ownership.zh-CN.md)

## 问题与范围

多个 Chrome profile 可以安装 Qwen 扩展并共享同一份 Native Host 注册。
各 profile 独立连接同一个 Browser Use socket。此前，每次握手都会替换当前连接，
使标签页失效，并把后续请求发往另一个 profile。因此，即使只有一个 Browser Use
session，也会在多个 profile 重连时反复失败。

本次保持[单 session 边界](browser-use.md)：每个 OS 用户只能运行一个活跃的
Browser Use runtime。此次只解决 profile 抢占，不增加 profile 选择界面或并发
Browser Use session。

## 身份与选择

每个扩展 profile 在 `chrome.storage.local` 的 `browserUseInstanceId` 中持久保存
一个随机 UUID。连接之前先写入，Native Host、service worker 和浏览器重启后复用。
如果写入失败，本次不连接，由现有重连 alarm 重试。清除扩展数据或重新安装可能改变身份。

协议版本 `2` 要求 `hello` 除了共享的 `extensionId`，还必须包含
`extensionInstanceId`。传输层在选择 profile 前拒绝缺失或无效的实例 ID。
扩展与 runtime 必须一起更新；版本 `1` 的握手无法可靠区分 profile，因此会被拒绝。
Native Host 继续只转发消息。这些标识用于区分兼容的实例，不能认证以同一 OS 用户
身份运行的其他进程。

发现连接时，不兼容的 Qwen 扩展不会阻止兼容 profile 在正常连接超时窗口内接入。
如果没有兼容连接，错误会明确指出需要更新扩展还是 Qwen Code。选定 profile 后，
只有该 profile 断线后的握手可以提供这一诊断，其他 profile 不能覆盖它。
兼容连接建立或停止 transport 时会清除诊断。

第一个有效握手选定当前 transport 生命周期使用的 profile。首次选择取决于连接顺序，
不会推测用户偏好的工作或个人账号。其他 profile 保持连接并待命。
它们的消息不能完成当前请求、向 SDK 发送事件、替换选中的 socket，或重置其标签页
和 session 名称。

## 断开与停止

连接断开时，按照现有生命周期让该连接的待完成请求失败，并使标签页句柄失效，
但保留选中的实例身份。只有同一实例可以重连；原实例不在线时，其他已连接 profile
也不能接管。如果选中的 profile 未返回，请求超时后报告 `BROWSER_DISCONNECTED`。
重连后可以重新发现并认领已有页面；旧句柄不会透明恢复。

停止 transport 会关闭活跃连接和待命连接，并清除选择。新的 transport 生命周期
可以选择另一个 profile。停止 Browser Use session 不会清除扩展持久保存的实例身份。

## 验证与验收

- 复现两个 profile 具有相同 tab ID 的场景；第二个连接不能改变原 profile 请求的去向。
- 待完成请求与事件必须和待命 profile 隔离，关闭待命连接不能通知 SDK 当前浏览器已断开。
- 两个真实的隔离 Chrome profile 共用同一 socket 至少 95 秒，原标签页不失效，
  分组名称不重置。
- 关闭并重启待命 profile 不影响活跃 profile；关闭活跃 profile 不自动切换，
  重启原 profile 后可以恢复使用。
- 扩展重连和 worker 重启后身份不变，不同 profile 的身份不同，且使用前已持久保存。
  存储失败时不能发布临时身份。
- 停止并重启 transport 可以重新选择，且所有旧连接均被关闭。第二个 runtime 仍报告
  `BROWSER_USE_BUSY`。

## 并发 session 后续工作

由 [#11609](https://github.com/QwenLM/qwen-code/issues/11609) 跟进。

Profile 身份与 Browser Use session 身份是两个概念。未来多个 session 可以共享
一个 profile，并分别拥有不同的标签页。这需要实现共享连接路由，以及按 session
隔离的标签页归属、事件、清理和重连。不能复用 CDP 子目标的 `sessionId` 作为
Browser Use session 身份。本次不实现这些机制。
