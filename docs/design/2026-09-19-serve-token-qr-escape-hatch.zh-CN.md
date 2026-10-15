# Serve 含 token 二维码逃生门与降级的纯地址二维码

[English](2026-09-19-serve-token-qr-escape-hatch.md) | [简体中文](2026-09-19-serve-token-qr-escape-hatch.zh-CN.md)

## 问题陈述

自 #11172 起，`qwen serve` 在非 loopback 绑定时会在启动阶段打印一个含 token 的二维码，编码 `<lan-url>/#token=<bearer>`——即与 Local Control 解耦的 QR 投递。但当 bearer 是**稳定的 operator 配置 token** 且 stdout **不是交互终端**时，二维码会被抑制：

```ts
if (!input.generated && !process.stdout.isTTY) return;
```

这个守卫维护了一个真实的不变量——operator 配置的长期凭证绝不能在每次重启时被重复写入被收集的 stdout(journald、容器日志、日志聚合系统），因为日志通常处在比 secret 配置存储更宽的访问控制域里。

但守卫当前的形状有三个缺陷：

1. **静默抑制。** 二维码被扣下时不打印任何内容。operator 除非读源码，否则无法发现原因。
2. **没有逃生门。** `isTTY` 无法区分"operator 在 SSH 终端里 tail 日志、可以扫屏幕上的 QR"（安全）和"stdout 被 ship 到 ELK"（泄漏）。daemon 看不到这个决定性变量，operator 知道——却没有 flag 可以表达。
3. **惩罚范围过宽。** 守卫把 QR *机制*和 _secret_ 一起抑制了。纯地址二维码的边际泄漏为零——同样的地址本就以纯文本行打印——而 Web Shell 的 `StandaloneAuth` 门禁在 URL 不含 token 时本就会要求输入 token。

## 现状

`printRemoteQuickstart`(`packages/cli/src/serve/remote-quickstart.ts`）在非 loopback 绑定时打印：地址行、generated-token 行（仅 ephemeral token)、非 TLS 时的明文警告，然后是 QR 块。QR 块要求 Web Shell(`web`)，选择一个可拨号的私有 LAN 候选地址（优先 routable 而非 link-local)，无候选时回退到 "QR unavailable" 行，然后应用上述抑制守卫。

## 提议的改动

所有改动都限制在启动 quickstart 块内；Local Control、认证模型和 Web Shell 均不涉及。

### 1. `--token-qr` 逃生门

`qwen serve` 新增布尔 flag（无默认值——区分"未传"与 `--no-token-qr`)，另有 settings.json 来源 `serve.tokenQr`（沿用 `serve.channels` 的先例：`settingsSchema.ts` 的 `serve` 对象）。开启后，即使在抑制场景（稳定 operator token + 非交互 stdout）也打印含 token 的二维码。operator 借此声明：_我的日志管道与 daemon 主机同等可信。_ 显式 flag（任一极性）优先；setting 仅在未传 flag 时生效。默认行为不变。

Plumbing:`ServeArgs['token-qr']` → `ServeOptions.tokenQr`，以及经 serve fast-path settings 摘要（`fast-path-settings.ts`）的 `serve.tokenQr`；flag 在 `run-qwen-serve.ts` 里唯一的 `printRemoteQuickstart` 调用点优先。settings 来源在这里——而不是 yargs 命令层——解析，是为了让从不经过 yargs handler 的 serve fast path 行为完全一致。

### 2. 抑制提示行

含 token 二维码被抑制时，打印一行说明原因和补救方法：

```text
Token-bearing QR suppressed: stable operator token with non-interactive stdout. Pass --token-qr to print it anyway.
```

显式 `--no-token-qr` 否决有独立的归因文案，而不是叫 operator 去传他刚传过的 flag；并且它在**所有 quickstart** 路径上都生效——包括交互终端和 generated token——因此负极性是一个真正的关闭开关，而不是照样打印凭证的空操作。（generated bearer 仍有自己的纯文本行送达 operator，所以否决不会让他失去访问途径。）该断言刻意限定在本输出块内：`--local-control` 会打印它自己的配对 QR，而 Local Control 要求 loopback 绑定——此时 quickstart 块压根不打印——所以不加限定的"所有路径"会让 operator 以为这次运行不会有凭证 QR 进日志，而实际上正在打印一个。

```text
Token-bearing QR suppressed: the token QR was explicitly disabled for this run.
```

若（通过 flag 或 setting）请求了 token 二维码但根本打不出来，在 stderr 上说明原因而不是静默丢弃请求——Web Shell 未挂载（`--no-web` 或资产未解析）与 loopback 绑定（不打印 QR:`quickstartPrintMode` 在此返回 `token-only` 或 `silent`，而 generated bearer 仍有自己的纯文本行）各有自己的归因：

```text
qwen serve: --token-qr / serve.tokenQr has no effect because the Web Shell is not mounted.
qwen serve: --token-qr / serve.tokenQr has no effect on this bind: a loopback listener prints no quickstart QR.
```

存在但格式错误的 `serve.tokenQr`（字符串、数字）会在 stderr 上被报告——只点名字段和其类型，绝不回显其值——并视为不存在。不回显值的原因：错误的值可能是直接粘进配置的字面 token，而不在 `INTERNAL_SECRET_ENV_VARS` 内的 `${VAR}` 占位符在到达诊断之前就会被替换——回显其中任何一种，都会在每次启动时把活的 bearer 重新写进被收集的 stderr。校验放在消费端而不是共享的 fast-path settings 读取器里：在读取器抛错会连带丢弃整个 boot summary——`policy.*` 和 `serve.channels` 一起——于是一个显示开关的拼写错误会静默把权限调解降级为默认值。

### 3. 降级的纯地址二维码

在抑制场景下，仍打印一个只编码候选地址 URL（无 `#token=` 片段）的二维码，并标注手机端会被要求输入 token:

```text
Scan to open Web Shell: <url> (<label>)
Address-only QR: the Web Shell will ask for the bearer token.
<QR>
```

纯地址二维码复用现有的候选地址选择和 best-effort `qrcode-terminal` 路径，只是编码内容更少。

## 关键设计决策

| 决策                                                                       | 理由                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认抑制保留                                                               | 安全默认值：托管环境（k8s/systemd + 日志外送）正是守卫保护的场景；只有 operator 知道自己的日志域，所以覆盖必须显式                                                                                                                                                                                                                                                                                                          |
| 用 flag 和 `serve.tokenQr` setting 做 opt-in                               | 与相邻 serve flag 及现有 `serve.*` settings 区块（`serve.channels`）一致；持久化部署（systemd unit、启动脚本）可在 settings.json 里设一次                                                                                                                                                                                                                                                                                   |
| 显式 flag（任一极性）优先于 setting                                        | `--no-token-qr` 必须能为单次运行否决 setting 开启的凭证打印——命令行上的显式选择是 operator 最强的信号；一个总被 setting 覆盖的 flag 就是凭证守卫上的死开关                                                                                                                                                                                                                                                                  |
| `serve.tokenQr` 仅认 user/system/system-defaults 作用域                    | workspace settings 文件（克隆仓库里的 `.qwen/settings.json`）绝不能把 operator 的稳定 bearer 推进被收集的 stdout。两条 settings 管线都做了强制：注册进 `WORKSPACE_RESTRICTED_SETTINGS`（驱动 workspace strip、被忽略值警告和对话框作用域过滤的唯一列表），且 serve fast-path 读取器结构上挑不到该键——读取器会把被丢弃的键上报，由 serve 启动路径在 stderr 上点名：daemon 路径才是真正读这个键的路径，它不能反而是沉默的那条 |
| 格式错误的 `serve.tokenQr` 被点名并忽略，校验放在消费端                    | 共享的 fast-path 读取器还承载 `policy.*` 和 `serve.channels`；在那里抛错会丢弃整个 summary，让一个显示开关的拼写错误把权限调解静默降级为 `first-responder`。把 `"true"` 静默当作不存在同样错误，所以由消费端带着字段名告警                                                                                                                                                                                                  |
| 否决有独立归因，且在所有 quickstart 路径生效                               | 显式 `--no-token-qr` 之后仍提示 "Pass --token-qr"，会在排障中错误归因；而只在 captured stdout 生效的否决，在 TTY 或 generated token 下照样打印凭证——等于一个什么都关不掉的开关。限定在 quickstart 块内，是因为 `--local-control` 在 loopback 绑定上会打印它自己的配对 QR，而那时本块压根不打印                                                                                                                              |
| Web Shell 未挂载与 loopback 绑定都报告而非静默                             | 这个 flag 的存在就是为了消除静默无效；`--no-web`、资产未解析和 loopback 绑定都会让请求失效，而此前只有第一种有诊断——同命令的 `--local-control` 则是 fail-fast 的                                                                                                                                                                                                                                                            |
| 抑制场景打印纯地址二维码                                                   | 边际泄漏为零（地址本就以文本打印），且 `StandaloneAuth` 门禁已处理 token 输入；在不削弱不变量的前提下消除"在手机上敲地址"的摩擦                                                                                                                                                                                                                                                                                             |
| 提示行逐字写出 `--token-qr`                                                | 静默抑制正是可发现性缺陷；补救方法必须能从日志里直接复制                                                                                                                                                                                                                                                                                                                                                                    |
| 无可拨号候选地址时不打提示                                                 | 现有 "QR unavailable" 回退已解释该场景；此时 `--token-qr` 提示无意义                                                                                                                                                                                                                                                                                                                                                        |
| 含 token 二维码文案不变（`SECRET QR: grants daemon access. Do not share.`) | 现有警告仍然准确；强制路径是同一凭证、同一 fragment                                                                                                                                                                                                                                                                                                                                                                         |

## 受影响文件

| 文件                                                         | 改动                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/commands/serve.ts`                         | `ServeArgs['token-qr']`、builder option、`serveOptions` 映射                                                                                                                                          |
| `packages/cli/src/config/settingsSchema.ts`                  | `serve.tokenQr` 布尔属性                                                                                                                                                                              |
| `packages/cli/src/config/settingsUtils.ts`                   | 将 `serve.tokenQr` 注册进 `WORKSPACE_RESTRICTED_SETTINGS`（workspace strip + 被忽略值警告 + 对话框作用域过滤）                                                                                        |
| `packages/cli/src/serve/types.ts`                            | `ServeOptions.tokenQr?: boolean` 及文档注释                                                                                                                                                           |
| `packages/cli/src/serve/fast-path.ts`                        | `token-qr` 布尔 flag → `ServeOptions.tokenQr`                                                                                                                                                         |
| `packages/cli/src/serve/fast-path-settings.ts`               | 仅从 operator 拥有的 settings 文件挑取并合并 `serve.tokenQr`；workspace 作用域的尝试经 `ignoredWorkspaceKeys` 上报                                                                                    |
| `packages/cli/src/serve/run-qwen-serve.ts`                   | 在 `printRemoteQuickstart` 处以 `opts.tokenQr` 优先于 `bootSettings.serve.tokenQr` 解析出 `tokenQrMode`；settings 读取失败警告中点名该字段；workspace 作用域被忽略的 `serve.tokenQr` 在 stderr 上点名 |
| `packages/cli/src/serve/remote-quickstart.ts`                | 抑制分支：提示行 + 纯地址二维码；已解析的 `tokenQrMode` 姿态                                                                                                                                          |
| `packages/cli/src/serve/remote-quickstart.test.ts`           | 更新抑制测试；新增提示/地址 QR/强制 QR 测试                                                                                                                                                           |
| `packages/cli/src/serve/fast-path.test.ts`                   | flag 枚举条目；settings 作用域与优先级测试                                                                                                                                                            |
| `packages/cli/src/serve/run-qwen-serve.test.ts`              | opts/boot settings 解析测试（含显式 false 否决）                                                                                                                                                      |
| `packages/cli/src/commands/serve.test.ts`                    | flag 映射 + `--no-token-qr` + 默认缺失测试                                                                                                                                                            |
| `docs/users/qwen-serve.md`                                   | flag 表格行 + QR 段落更新                                                                                                                                                                             |
| `docs/design/serve-remote-quickstart.md`                     | 既有 quickstart 设计中被本改动取代的 QR 门控句，已更新并指向本文档                                                                                                                                    |
| `packages/vscode-ide-companion/schemas/settings.schema.json` | schema 新增项的生成镜像（由构建再生成）                                                                                                                                                               |

## 范围边界

- **默认情况下**不改变 generated-token 或交互 TTY 路径——仍然打印完整含 token 二维码，除非显式 `--no-token-qr` 否决它，此时两者都降级为纯地址二维码（见上文否决行）。settings 层的 `false` 不是否决：否决信号只来自 flag(printer 拿到的已解析 `tokenQrMode` 仅当 `opts.tokenQr === false` 时为 `'veto'`)，因此 settings 的 `false` 只是不开启 opt-in，仍由默认策略抑制决定。
- 不改变 loopback 的 `token-only`/`silent` 模式。
- 不改变 Local Control、其监听模型或其配对 token。
- 不改 Web Shell;`StandaloneAuth` 的 token 输入按现状使用。
- 二维码不做重试/持久化；仍是启动时的一次性输出块。

## 验证计划

`remote-quickstart.test.ts` 的单元测试覆盖：抑制提示文案、纯地址二维码载荷（不得以原始或编码形式包含 token)、`--token-qr` 强制含 token 二维码、否决在 generated-token 与 TTY 路径上的降级输出，以及 generated-token/TTY/no-web/无候选路径的**默认**行为不变。E2E 计划见 `.qwen/e2e-tests/serve-token-qr.md`——先对全局安装的 CLI 跑基线，再对 `node dist/cli.js` 跑同一矩阵。

## 验收标准

1. 稳定 token + 重定向 stdout：打印提示行和纯地址二维码；任何行都不以原始或 URL 编码形式包含 token。
2. `--token-qr` + 稳定 token + 重定向 stdout：打印含 token 二维码及现有 SECRET 警告。
3. 未传 `--token-qr` / `--no-token-qr` 时，generated token、交互 TTY、`--no-web`、无候选路径的输出与改动前逐字节一致。
4. `qwen serve --help` 列出 `--token-qr`。

## 待定问题

无。
