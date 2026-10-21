# Web Shell 设备注册表

[English](web-shell-device-registry.md) | [简体中文](web-shell-device-registry.zh-CN.md)

- 状态：本次变更中实现
- 日期：2026-10-21
- Issue：[#14947](https://github.com/QwenLM/qwen-code/issues/14947)
- 参考提交：`a8616497861fd779a0a90d3d2986b5327211f03d`

## 问题

在局域网上提供 Web Shell 的 daemon 通过 `POST /web-shell/pairing` 与
`POST /web-shell/pairing/exchange` 签发设备凭据。这些凭据在主监听器上会被
`CredentialStore.verify()` 接受，因此已配对的浏览器或桌面客户端拥有完整的 daemon
API 权限。

目前这种权限无法按设备收回：

- `#webShell` 是一个存放未加盐 SHA-256 摘要的 `Set<Buffer>`。因为没有 id，调用方无法
  指名要吊销哪台设备。
- 仅有的管理手段是 128 台上限（`409 Paired device limit reached. Restart the daemon to
reset pairing.`）和重启 daemon，而重启会一次性清除所有设备。
- exchange 的响应是 `{ token }`，客户端因此无法记录自己的凭据对应哪个设备身份。

对用户可见的后果写在 #14947 里：删除一条已保存的连接时，无法同时删除该连接使用的
凭据；一台丢失或与他人共用的客户端，也只能靠断开所有设备来解除配对。

## 当前状态

| 部分     | 位置                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------- |
| 凭据存储 | `packages/cli/src/serve/local-control/credentials.ts`                                              |
| 配对路由 | `packages/cli/src/serve/routes/web-shell-pairing.ts`                                               |
| 挂载点   | `packages/cli/src/serve/server.ts` —— `registerWebShellPairingRoutes` 在全局 bearer 中间件之前运行 |
| 权限模型 | `verify()` 在主监听器上接受 runtime token 或任意设备令牌；设备令牌在 local-control 监听器上被拒绝  |

## 目标

1. 让每台已配对设备拥有可寻址的稳定 id。
2. 让运维方能够列出已配对设备，且不暴露其凭据。
3. 让运维方能够吊销单台设备，且吊销立即对 `verify()` 生效。

## 非目标

- 不改变哪个监听器接受设备凭据。
- 不增加过期时间。被「记住」的凭据预期会一直有效直到被吊销；加入过期需要一套目前
  并不存在的续期流程。
- 不跨 daemon 重启持久化。持久化需要先回答「两次 daemon 进程凭什么算同一个 daemon」：
  按端口做键会在临时端口上静默丢失设备，而机器级实例 id 会让两个 daemon 互相接受对方
  的凭据。这一点在 #14947 中仍是未决问题。
- 不修改客户端。`persistDaemonToken` 与连接流程保持不变。

## 设计

### 数据模型

`CredentialStore` 把 `#webShell: Set<Buffer>` 替换为
`Map<string, { digest: Buffer; createdAt: number }>`，以设备 id 为键。id 由路由在
exchange 成功时用 `randomUUID()` 生成；存储层不自行生成 id，因此调用方无法签发出一个
自己无法指名的凭据。

`MAX_WEB_SHELL_DEVICES` 保持 `128`，语义不变。

`verify()` 在命中之后仍会用 `timingSafeEqual` 比较作用域内的每一个摘要，因此成功校验
的耗时不会暴露命中的是哪一条。

### HTTP 接口

| 路由                               | 鉴权             | 行为                                                          |
| ---------------------------------- | ---------------- | ------------------------------------------------------------- |
| `POST /web-shell/pairing`          | bearer（既有）   | 不变                                                          |
| `POST /web-shell/pairing/exchange` | 配对密钥（既有） | 现在返回 `{ token, deviceId }`                                |
| `GET /web-shell/devices`           | bearer           | `{ devices: [{ id, createdAt }] }`，`Cache-Control: no-store` |
| `DELETE /web-shell/devices/:id`    | bearer           | `{ revoked: true }`，或 `404 { error: 'Unknown device' }`     |

两个新路由由 `registerWebShellPairingRoutes` 注册，与它们补全的配对路由放在一起。该模块
在全局 bearer 中间件之前挂载，因此每个路由各自声明 `bearerAuth(credentials)`——与签发
路由的写法一致。`Cache-Control: no-store` 与既有的配对响应保持一致。

权限模型选择沿用而非扩展：设备令牌本来就能通过 `POST /web-shell/pairing`，也就是说已
配对的客户端对配对流程已具备运维级权限。引入「仅运维」这一层级属于另一次鉴权变更，
不是「让设备可寻址」的一部分。

### 错误

- 未知设备 id：`404` 与 `{ error: 'Unknown device' }`——被吊销的设备与从未签发过的设备
  故意不可区分。
- 达到上限：沿用 `409`。既然设备现在可吊销，该消息里「重启 daemon」的建议从唯一手段
  变成了兜底；为避免改动既有错误契约，文案保持不变。

### 线上兼容

`deviceId` 是 exchange 响应上的新增字段。只读取 `token` 的客户端不受影响；
`packages/web-shell/client/config/pairing.ts` 会忽略未知字段。

## 约束

- `packages/cli/src/serve/**` 属于核心基础设施；本次变更完全落在其中，且不引入新依赖。
- 设备凭据仍然只存在于内存中，因此 #14947 描述的 daemon 重启行为不受本设计影响。

## 风险

- **设备管理的运维权限。** 由于设备令牌可以认证这两个路由，已配对的客户端可以列出并
  吊销其他设备。这与既有模型一致（已配对客户端本来就能签发新的配对邀请）。收紧这一
  点需要在 `bearerAuth` 中引入凭据类型信号，属于更大的改动。
- **id 泄露。** 设备 id 不是秘密，但会作为稳定标识返回给任何已认证客户端。它不泄露
  任何令牌信息。

## 验证计划

- `packages/cli/src/serve/routes/web-shell-pairing.test.ts`：
  exchange 返回 UUID 形状的 `deviceId`；列表包含该 id 且不包含令牌；吊销一台设备后其
  令牌不再通过认证，另一台设备仍可用；重复吊销返回 `404`；两个路由都拒绝未认证请求。
- 既有配对、鉴权与 capabilities 测试套件必须保持通过。

## 验收标准

- 成功的 exchange 会为其设备命名。
- 运维方可以在不暴露任何令牌材料的情况下列出已配对设备。
- 吊销设备后，其凭据立即无法通过校验。
- 128 台上限与监听器分域保持不变。

## 后续工作

- 在 daemon 身份问题有答案后，让注册表跨重启持久化（见 #14947）。
- 将 `forgetRemoteConnection` 接到吊销其保存的设备上，使删除已保存连接同时删除凭据。
- 如果引入续期流程，再考虑过期时间。
