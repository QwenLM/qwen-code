# Feishu observed-contact label enrichment

## 中文说明

### 目标

在不延迟飞书入站消息处理的前提下，用真实用户名和群名补全观测联系人
的 label。名称查询不可用时继续保留现有 ID label。

### 设计

`ChannelBase` 在入站消息通过 preflight 后，仍先立即落盘基于 ID 的观测
记录。随后调用一个同步的 protected 后置观测钩子。默认实现不执行任何
操作，返回值也不会被等待，因此不影响其他渠道。

`FeishuChannel` 覆写该钩子，对当前 channel 实例生命周期内尚未尝试过的
ID 发起后台查询：

- `POST /open-apis/contact/v3/users/basic_batch` 查询发送者姓名。
- `GET /open-apis/im/v1/chats/:chat_id` 查询群名。

用户和群分别使用进程内缓存，但共用同一套查询生命周期：同一个 ID
的并发请求复用同一个 Promise。查询成功的名称先经过共享的发送者名称净
化，再供后续消息直接复用；请求已送达飞书的失败查询记录到 daemon 重
启为止，因 tenant token 获取失败而未能发出的请求以及收到 401 的请求
保持可重试，401 同时使缓存的 tenant token 失效。daemon 重启后第一条
入站消息会从已持久化的观测联系人记录回填此前解析出的名称，避免已知
名称在重新查询期间被回退为原始 ID。查询请求的 HTTP 错误、API 错误、
解析错误和超时均不输出日志。

任一名称查询成功后，飞书通过 `ChannelBase` 现有持久化方法再次写入观测
记录。由于 channel、用户、群和话题 ID 均未改变，
`ObservedChannelContactStore` 会直接用名称 label 替换 ID label，无需修改
存储格式。查询均失败时，首次写入的 ID 观测记录保持不变。

### 顺序与访问控制

只有现有 preflight 通过且首次观测落盘尝试完成后，才开始名称补全。重复事件、被
适配器丢弃的空消息，以及未通过发送者或群策略的消息都不会触发查询。
后台查询不会被 `handleInbound` 或 Agent prompt 主链路等待。

### 权限

发送者姓名查询使用最小权限 `contact:user.basic_profile:readonly`，群名查询
使用 `im:chat:readonly`。ID 仍具有应用隔离性，因此跨应用 ID 和外部用户
可能无法补全。

### 测试

Channel Base 测试验证后置观测钩子只在 preflight 后触发且不会被等待。
飞书适配器测试验证成功补全、进程内去重、后续消息复用名称、daemon 重启
后回填已解析名称，以及失败静默时原始 ID 观测记录和入站消息处理仍然可用。

## English

### Goal

Populate Feishu observed-contact labels with the sender name and group name
without delaying inbound message processing. Keep the current ID labels when
lookup is unavailable.

### Design

`ChannelBase` continues to persist the ID-based observation immediately after
inbound preflight succeeds. It then invokes a synchronous, protected
post-observation hook. The default hook does nothing and its return value is
not awaited, so other channel implementations are unchanged.

`FeishuChannel` overrides the hook and starts background lookups for IDs that
have not been attempted during the current channel instance lifetime:

- `POST /open-apis/contact/v3/users/basic_batch` resolves the sender name.
- `GET /open-apis/im/v1/chats/:chat_id` resolves the group name.

User and group lookups share one lookup lifecycle: process-local caches dedupe
by ID, and concurrent requests for the same ID share one promise. A successful
name is sanitized with the shared sender-name sanitizer and reused on later
envelopes. A failed attempt whose request reached Feishu is retained until the
daemon restarts; attempts never issued because tenant-token acquisition failed,
and requests answered with 401, remain retryable, and a 401 also invalidates
the cached tenant token. The first inbound message after a daemon restart
hydrates labels resolved by earlier runs from the persisted observed-contact
registry, so known names are not reverted to raw IDs while the fresh lookup is
pending. Lookup HTTP, API, parsing, and timeout failures produce no log
output.

When either lookup succeeds, Feishu writes a second observation through the
existing `ChannelBase` persistence method. The observation has the same
channel, user, group, and topic IDs, so `ObservedChannelContactStore` replaces
the ID labels without requiring a storage-format change. An unsuccessful
lookup leaves the first ID-based observation intact.

### Ordering and access control

Enrichment starts only after the existing inbound preflight succeeds and the
initial observation attempt completes. Duplicate events, empty messages
rejected by the adapter, and messages rejected by sender or group policy do not
trigger lookups. The background lookup is not awaited by `handleInbound` or the
agent prompt path.

### Permissions

Sender-name enrichment uses the least-privilege
`contact:user.basic_profile:readonly` scope. Group-name enrichment uses
`im:chat:readonly`. IDs remain application-scoped, so cross-application IDs and
external users may remain unresolved.

### Testing

Channel-base tests verify that the post-observation hook runs after preflight
and is not awaited. Feishu adapter tests verify successful enrichment,
process-local de-duplication, cached labels on later envelopes, hydration of
previously resolved labels after a daemon restart, and silent failure while the
original ID-based observation and inbound processing remain available.
