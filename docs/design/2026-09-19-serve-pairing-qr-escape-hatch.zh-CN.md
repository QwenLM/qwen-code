# Serve 配对二维码逃生门与降级的纯地址二维码

[English](2026-09-19-serve-pairing-qr-escape-hatch.md) | [简体中文](2026-09-19-serve-pairing-qr-escape-hatch.zh-CN.md)

## 问题陈述

自 #11172 起，`qwen serve` 在非 loopback 绑定时会在启动阶段打印一个配对二维码，编码 `<lan-url>/#token=<bearer>`——即与 Local Control 解耦的 QR 投递。但当 bearer 是**稳定的 operator 配置 token** 且 stdout **不是交互终端**时，二维码会被抑制：

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

### 1. `--pairing-qr` 逃生门

`qwen serve` 新增布尔 flag（无默认值——区分"未传"与 `--no-pairing-qr`)，另有 settings.json 来源 `serve.pairingQr`（沿用 `serve.channels` 的先例：`settingsSchema.ts` 的 `serve` 对象）。开启后，即使在抑制场景（稳定 operator token + 非交互 stdout）也打印含 token 的二维码。operator 借此声明：_我的日志管道与 daemon 主机同等可信。_ 显式 flag（任一极性）优先；setting 仅在未传 flag 时生效。默认行为不变。

Plumbing:`ServeArgs['pairing-qr']` → `ServeOptions.pairingQr`，以及经 serve fast-path settings 摘要（`fast-path-settings.ts`）的 `serve.pairingQr`；flag 在 `run-qwen-serve.ts` 里唯一的 `printRemoteQuickstart` 调用点优先。settings 来源在这里——而不是 yargs 命令层——解析，是为了让从不经过 yargs handler 的 serve fast path 行为完全一致。

### 2. 抑制提示行

含 token 二维码被抑制时，打印一行说明原因和补救方法：

```text
Token-bearing QR suppressed: stable operator token with non-interactive stdout. Pass --pairing-qr to print it anyway.
```

### 3. 降级的纯地址二维码

在抑制场景下，仍打印一个只编码候选地址 URL（无 `#token=` 片段）的二维码，并标注手机端会被要求输入 token:

```text
Scan to open Web Shell: <url> (<label>)
Address-only QR: the Web Shell will ask for the bearer token.
<QR>
```

纯地址二维码复用现有的候选地址选择和 best-effort `qrcode-terminal` 路径，只是编码内容更少。

## 关键设计决策

| 决策                                                                       | 理由                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认抑制保留                                                               | 安全默认值：托管环境（k8s/systemd + 日志外送）正是守卫保护的场景；只有 operator 知道自己的日志域，所以覆盖必须显式                                                                                                                             |
| 用 flag 和 `serve.pairingQr` setting 做 opt-in                             | 与相邻 serve flag 及现有 `serve.*` settings 区块（`serve.channels`）一致；持久化部署（systemd unit、启动脚本）可在 settings.json 里设一次                                                                                                      |
| 显式 flag（任一极性）优先于 setting                                        | `--no-pairing-qr` 必须能为单次运行否决 setting 开启的凭证打印——命令行上的显式选择是 operator 最强的信号；一个总被 setting 覆盖的 flag 就是凭证守卫上的死开关                                                                                   |
| `serve.pairingQr` 仅认 user/system/system-defaults 作用域                  | workspace settings 文件（克隆仓库里的 `.qwen/settings.json`）绝不能把 operator 的稳定 bearer 推进被收集的 stdout；`readSettingsSummary` 只对 operator 拥有的文件读取挑这个键，workspace 文件结构上就不可能携带它——这是结构性排除，不是信任检查 |
| 抑制场景打印纯地址二维码                                                   | 边际泄漏为零（地址本就以文本打印），且 `StandaloneAuth` 门禁已处理 token 输入；在不削弱不变量的前提下消除"在手机上敲地址"的摩擦                                                                                                                |
| 提示行逐字写出 `--pairing-qr`                                              | 静默抑制正是可发现性缺陷；补救方法必须能从日志里直接复制                                                                                                                                                                                       |
| 无可拨号候选地址时不打提示                                                 | 现有 "QR unavailable" 回退已解释该场景；此时 `--pairing-qr` 提示无意义                                                                                                                                                                         |
| 含 token 二维码文案不变（`SECRET QR: grants daemon access. Do not share.`) | 现有警告仍然准确；强制路径是同一凭证、同一 fragment                                                                                                                                                                                            |

## 受影响文件

| 文件                                                         | 改动                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/src/commands/serve.ts`                         | `ServeArgs['pairing-qr']`、builder option、`serveOptions` 映射                                                                 |
| `packages/cli/src/config/settingsSchema.ts`                  | `serve.pairingQr` 布尔属性                                                                                                     |
| `packages/cli/src/serve/types.ts`                            | `ServeOptions.pairingQr?: boolean` 及文档注释                                                                                  |
| `packages/cli/src/serve/fast-path.ts`                        | `pairing-qr` 布尔 flag → `ServeOptions.pairingQr`                                                                              |
| `packages/cli/src/serve/fast-path-settings.ts`               | 仅从 operator 拥有的 settings 文件挑取并合并 `serve.pairingQr`                                                                 |
| `packages/cli/src/serve/run-qwen-serve.ts`                   | 在 `printRemoteQuickstart` 处以 `opts.pairingQr` 优先于 `bootSettings.serve.pairingQr` 解析；settings 读取失败警告中点名该字段 |
| `packages/cli/src/serve/remote-quickstart.ts`                | 抑制分支：提示行 + 纯地址二维码；`pairingQr` 旁路                                                                              |
| `packages/cli/src/serve/remote-quickstart.test.ts`           | 更新抑制测试；新增提示/地址 QR/强制 QR 测试                                                                                    |
| `packages/cli/src/serve/fast-path.test.ts`                   | flag 枚举条目；settings 作用域与优先级测试                                                                                     |
| `packages/cli/src/serve/run-qwen-serve.test.ts`              | opts/boot settings 解析测试（含显式 false 否决）                                                                               |
| `packages/cli/src/commands/serve.test.ts`                    | flag 映射 + `--no-pairing-qr` + 默认缺失测试                                                                                   |
| `docs/users/qwen-serve.md`                                   | flag 表格行 + QR 段落更新                                                                                                      |
| `packages/vscode-ide-companion/schemas/settings.schema.json` | schema 新增项的生成镜像（由构建再生成）                                                                                        |

## 范围边界

- 不改变 generated-token 或交互 TTY 路径（仍然打印完整含 token 二维码）。
- 不改变 loopback 的 `token-only`/`silent` 模式。
- 不改变 Local Control、其监听模型或其配对 token。
- 不改 Web Shell;`StandaloneAuth` 的 token 输入按现状使用。
- 二维码不做重试/持久化；仍是启动时的一次性输出块。

## 验证计划

`remote-quickstart.test.ts` 的单元测试覆盖：抑制提示文案、纯地址二维码载荷（不得以原始或编码形式包含 token)、`--pairing-qr` 强制含 token 二维码，以及 generated-token/TTY/no-web/无候选路径的行为不变。E2E 计划见 `.qwen/e2e-tests/serve-pairing-qr.md`——先对全局安装的 CLI 跑基线，再对 `node dist/cli.js` 跑同一矩阵。

## 验收标准

1. 稳定 token + 重定向 stdout：打印提示行和纯地址二维码；任何行都不以原始或 URL 编码形式包含 token。
2. `--pairing-qr` + 稳定 token + 重定向 stdout：打印含 token 二维码及现有 SECRET 警告。
3. Generated token、交互 TTY、`--no-web`、无候选路径的输出与改动前逐字节一致。
4. `qwen serve --help` 列出 `--pairing-qr`。

## 待定问题

无。
