# Web Shell 动态配对

[English](web-shell-dynamic-pairing.md) | [简体中文](web-shell-dynamic-pairing.zh-CN.md)

## 问题与范围

目前手机访问按钮依赖 Local Control，后者给 loopback daemon 增加局域网
监听端口，无法在已有非 loopback 监听上启用。二维码还直接包含长期 bearer。
本次让 Web Shell 按钮在已认证的非 loopback 主监听上默认可用，不增加监听
端口，也不要求先修改设置。终端二维码和现有 loopback Local Control 流程不在
本次范围内。

## 设计

现有手机访问弹层向所连接的 daemon 请求配对码。配对码包含 256 位随机数据，
60 秒过期，仅可兑换一次。弹层每 45 秒刷新，并显示剩余有效时间；刷新失败时
隐藏已过期的二维码，允许重试。关闭弹层停止刷新。旧码只保留原始有效期，
让正在进行的扫码有机会完成。
响应携带 `expiresInMs`，浏览器收到后开始本地倒计时，避免 daemon 与浏览器
时钟偏差导致延迟刷新。daemon 始终使用自身时钟强制校验过期。
页面中的二维码字符块局部设置 `lang="en"`：CJK 字体回退可能使方块与空格宽度不同，
破坏二维码网格。周围文案继续使用所选界面语言。

URL 使用 `#pairing=`，不包含 daemon bearer。独立页面启动时移除该 fragment，
仅向页面自身 origin 兑换配对码，然后进入常规认证流程。独立设备 bearer
沿用现有按标签页存储 token 的机制，可用于主监听上的 HTTP、SSE 和 WebSocket。
设备凭证在 daemon 进程生命周期内有效，最多配对 128 个设备；达到上限后拒绝
新配对，不断开已有设备。重启撤销全部配对码与设备凭证。二维码过期不会结束
设备访问。

两个新增路由都属于 process-global，与工作区选择无关。
`POST /web-shell/pairing` 要求已有主监听认证。
`POST /web-shell/pairing/exchange` 在常规 bearer gate 之前，只验证通过
Authorization header 传入的配对码。它只接受签发时的 origin，且只在主监听
上生效。配对码永远不能直接授权 API 请求或 WebSocket。
包含凭证的响应设置 `Cache-Control: no-store`。
启用 `--rate-limit` 时，两个路由都使用现有的 mutation 档限流器。
签发先验证主监听的有效 bearer。兑换请求在校验前按 socket IP 单独计数，包括无效
配对码，避免未认证请求通过更换 client ID 绕过限流。返回 429 不会消耗配对码。

主监听 HTTP 的 Host 校验不变。已认证的非 loopback 主监听现在允许 Origin 与
实际 socket 的协议及 Host 匹配的 WebSocket 升级请求。该场景跳过基于 loopback
socket 的 Host 白名单，与 REST 现有的非 loopback 策略一致，仍要求有效 bearer。
这适用于主监听上的全部 WebSocket 功能，包括 ACP、终端和语音，runtime 凭证与
设备凭证均可使用。loopback 与 Local Control 监听保留原有校验。
终止 TLS 或改写 Host 的代理仍需为浏览器的 origin 配置 `--allow-origin`。

同源兑换请求仅获得针对 runtime bearer Origin 检查的窄例外，仍由兑换处理器
验证自身凭证；即使其它 API 请求显式允许某个外部 origin，兑换处理器也会拒绝它。
设备 bearer 使用 REST 与 WebSocket 共用的凭证仓库。不新增预认证冷启动例外：
配对码只能存在于已经初始化的 runtime 中。

使用浏览器连接 daemon 时的地址。若 wildcard 监听经 loopback 访问，提供
现有符合条件的局域网接口，多个接口时由用户选择。保留 HTTP 或 HTTPS，
提示 HTTP 流量未加密，不自动增加 TLS。最多保存 64 个有效配对码，超过时
移除最早签发的码。

## 受影响组件

- CLI 凭证仓库、主监听同源认证、启动提示、daemon 路由接入及新增配对路由/服务测试。
- Web Shell 手机访问弹层、独立页面 token 启动流程、双语文案和针对性测试。
- 现有 Local Control 路由继续作为 loopback daemon 的回退流程。

## 验证与验收

先用全局 `qwen` 验证基线，再用构建后的 daemon 和浏览器验证完整流程。
覆盖非 loopback 默认可用、二维码自动轮换、倒计时、一次性与过期拒绝、
二维码不含 runtime bearer、轮换后设备仍可访问、主监听与 Local Control
隔离、同源和跨域检查、wildcard 地址选择及 loopback 原流程不变。
同时覆盖 allowlist 中的外部 origin，以及配置限流后的签发、无效兑换拒绝和
被限流配对码的成功重试。
完成构建、类型检查、针对性测试、两次全量 diff 自审及代码审查。
结果记录在 `.qwen/e2e-tests/web-shell-dynamic-pairing.md`。

## 待定问题

无。设备管理 UI、单设备撤销、终端轮换及单独 Local Control 流程改造留待后续。
