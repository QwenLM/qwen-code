# Local Control 配对

[English](local-control-cli.md) | [简体中文](local-control-cli.zh-CN.md)

## 目标

把对现有 `qwen serve` 会话的手机访问变成一条显式命令：

```bash
qwen serve --local-control
```

该命令让主守护进程保持 loopback 绑定，启动一个选定的 LAN 监听器，铸造一个可撤销的配对令牌，打印其二维码，并在 Local Control 关闭之前抑制系统睡眠。桌面端通过 Web Shell 设置卡片暴露同一个由守护进程持有的工作流。

## 行为

`--local-control` 是在现有守护进程与 Web Shell 之上的一个 opt-in 快捷方式。它不改变守护进程的运行时令牌、已配置的 origin 和已解析的端口，在一个选定的 IPv4 地址上新增一个 LAN 监听器——默认是 private/link-local 地址，或者是用 `--local-control-address` 显式指定的地址——在会话活动期将该通告 origin 加入白名单，并在渲染二维码之前把配对令牌放进 URL fragment。

终端仍然是可见的启用指示器。`Ctrl+C` 结束的是整个守护进程，而不只是 Local Control：优雅退出流程会关闭 LAN 监听器、作废配对令牌，并在进程退出前释放现有的跨平台睡眠抑制器。要在守护进程继续运行的情况下关闭 Local Control，请使用 Web Shell 设置卡片，它也是进程内唯一的重新启用路径。

该模式会拒绝非默认的 `--hostname` 和 `--no-web`，而不是静默创建不完整的配置。它可以与 `--token`、`--allow-origin` 以及临时端口 `0` 组合；当有多个候选地址时，`--local-control-address` 用于选择 LAN 地址，同时也是对 private/link-local 范围之外地址或 VPN/tunnel 接口上地址的显式 opt-in。已有的显式 `qwen serve` 部署不受影响。

## 安全

- LAN 暴露需要显式的运维操作：启动时加 `--local-control`，或由仅由主 loopback 监听器服务的 enable 请求发起；从 LAN 监听器到达的 enable 请求会被拒绝。
- 每次启用都从 `crypto.randomBytes(32)` 获取一个新的配对令牌；LAN 监听器不复用环境变量中的令牌。
- Local Control 把通告的 LAN origin 加入守护进程级 origin 白名单（会话活动期 `--allow-origin` 规则在两个监听器上都保持生效）；每条受保护的 LAN 路由仍然要求配对令牌。
- 令牌只存在于 URL fragment 中，因此在 Web Shell 保存它之前，浏览器不会把它放进 HTTP 请求、访问日志或 referrer。
- 现有的 bearer 认证、恒定时间比较和非 loopback 启动检查仍然是强制边界。
- 只有 private/link-local 的 IPv4 接口地址会被自动通告，这条路径保持不变：自动过滤器（RFC 1918/3927 范围检查和软件接口名称启发式）是没有任何显式标志时地址被提供的唯一途径。多个接口会呈现为显式选择，而不是猜测哪个网络正确。运维人员可以通过 `--local-control-address` 显式指定地址，从而 opt in 到这些范围之外的地址——或 VPN/tunnel 接口上的地址，例如手机和笔记本电脑在同一个企业 VPN 上。被接受的前提是主机确实持有该地址，但这是必要而非充分的：保留地址段（0/8、127/8、224/4 及以上）即使被某个接口持有，也会以 `reserved_lan_address` 被拒绝，因为 unspecified 地址会监听所有接口，而 multicast/保留地址段永远无法用于手机配对。凡是被自动过滤器拒绝的选中地址（超出私有地址空间，或位于 VPN/tunnel 接口上）都会以醒目的警告记录日志。该 opt-in 与 CLI 来源绑定：HTTP enable 路由只接受当前自动候选地址或运维人员在守护进程启动时指定的地址，因此本地进程无法把监听器移动到运维人员从未选择过的地址上。“VPN/tunnel 接口”是接口名称启发式（`isSoftwareNetwork`），不是接口的结构性属性：它匹配常见的 tunnel、bridge 和 VPN 适配器名称（`utun`、`wg`、`tailscale`、`docker`、OpenVPN Wintun 等），因此该 opt-in 的覆盖范围恰好是这个启发式所能识别的接口名称集合。

## 桌面端行为

桌面端让其内置守护进程保持需要认证的 loopback 绑定。Web Shell 设置卡片启用同一个由守护进程持有的 Local Control 服务，后者启动 LAN 监听器、生成独立的配对令牌和二维码，并获取平台睡眠抑制器。该监听器校验其公网 Host 和 Origin，并且对 LAN 流量只接受配对凭据。桌面端 PID、守护进程 PID、loopback 地址和存活会话都不改变。

从设置中关闭 Local Control 会关闭监听器和活动连接、释放睡眠抑制并作废配对令牌。之后的再次启用会获得新令牌。模式关闭时 LAN 监听器不存在，因此正常的桌面端运行时保持仅 loopback。

默认情况下该模式只覆盖同网络访问。`--local-control-address` opt-in 可以绑定主机持有的可路由地址，这会把网关暴露到本地网络之外——这正是该 opt-in 要求主机确实持有该地址并记录醒目警告的原因。授权在指定地址首次成功启用时被记录，在 disable 之后仍然存活，因此 Web Shell 卡片可以重新提交它；首次在不同地址上成功启用会撤销该授权——在设置卡片上点击另一行，授权就会在守护进程的剩余生命周期内失效。此类选中地址应与 `--tls-cert`/`--tls-key` 配对使用，并注意 LAN 监听器出示的是同一张证书：其 subjectAltName 必须覆盖所选地址，否则配对客户端会在 TLS 握手时以 `ERR_TLS_CERT_ALTNAME_INVALID` 失败——守护进程只针对主/worker 拨号主机校验证书，从不针对 LAN 地址校验。作为产品能力的互联网远程控制仍然需要带账号认证、具备可重连会话状态的出站中继；绝不能通过端口转发或无认证隧道暴露这个 LAN 网关来实现。

## 验证

- 单元测试覆盖标志冲突、生成令牌的交接、LAN URL 构造、二维码输出和睡眠抑制。
- 桌面端 Rust 测试覆盖网关的 Host/Origin 边界、HTTP bearer 转换、WebSocket 子协议转换和仅 loopback 目标要求。
- 一次真实的本地守护进程运行验证：二维码 URL 能通过 `/capabilities` 认证、Web Shell 可加载，且睡眠抑制器只存活于 Local Control 进程。
- 一次打包后的 macOS 应用验证：启用 Local Control 保留现有守护进程/会话，二维码能从第二个浏览器打开该会话，禁用它则撤销 LAN 监听器和睡眠断言。
- 现有 `serve` 命令与睡眠抑制器测试保持绿色，随后执行构建和类型检查。
