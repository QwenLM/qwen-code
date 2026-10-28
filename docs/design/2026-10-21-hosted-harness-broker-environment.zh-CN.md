# Hosted Harness Broker 环境变量与固定端口

[English](2026-10-21-hosted-harness-broker-environment.md) | [简体中文](2026-10-21-hosted-harness-broker-environment.zh-CN.md)

状态：已提出，并在同一变更中实现。

## 问题

随包的 systemd unit 通过 `--managed-runtime-broker-url` 和 `--managed-runtime-broker-token` 把 Runtime Broker 交给 Hosted Harness，做法是把 `QWEN_HOSTED_HARNESS_BROKER_ARGS` 展开进命令行。本机任何用户都能从 `/proc/<pid>/cmdline` 读到 Broker token。unit 及其环境模板都因此带有警告：工具路径只能用于单租户主机。

Broker token 还被存了两份：Harness 通过 `harness.env` 获得它，控制面通过 `server.env` 里的 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` 获得它，每次轮换都要改两处。

另外，请求的端口被占用时，`qwen serve` 会顺延到下一个空闲端口。对 Hosted Harness 来说，这从来不是运维想要的。控制面写死了一个 Harness URL，因此顺延后的 Harness 能正常启动，却让每个 Session 都失败，直到有人修改 `server.env`。部署文档和 systemd README 只是记录了这个陷阱，而没有阻止它。

## 目标

- 随包文件不再把 Broker token 放在命令行上。
- token 不会传给 Harness 启动的进程。
- 在 Harness 凭据文件的基础上，`harness.env` 为两个进程只保存一份 Broker token。
- Harness 端口被占用时启动失败，而不是顺延。

## 非目标

- 改变 default profile 的端口顺延。
- 改变 Broker 的认证方式或 token 格式。
- 删除现有的命令行选项；它们继续有效，并且优先。

## 设计

### Broker 环境变量

缺少 `--managed-runtime-broker-url` 和 `--managed-runtime-broker-token` 时，`qwen serve` 已经会回落到 `QWEN_MANAGED_RUNTIME_BROKER_URL` 和 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`，并在读取后把这两个变量从自己的环境中删除；这是本地 Managed 命令（#14928）加入的。本设计直接使用这两个变量，不再另加一对。`validateHostedHarnessProfile` 仍要求两个值同时存在或同时缺省，并且只有 Hosted Harness profile 接受它们。

### 子进程环境

token 在读取后就离开了 Harness 自身的环境，因此 Harness 启动的进程都无法从那里继承它。为了照顾嵌入式调用方，以及在此之前复制过环境的路径，每份剔除 Qwen 内部 secret 的名单也都加入了它：

- `SCRUBBED_CHILD_ENV_KEYS`：ACP bridge 从每个 `qwen --acp` 子进程中剔除，与 `QWEN_SERVER_TOKEN` 并列；
- core 的 `INTERNAL_SECRET_ENV_VARS`：shell 命令、hook、monitor 工具和 stdio MCP server 启动时不带这些变量；它同时阻止仓库提供的 `${QWEN_MANAGED_RUNTIME_BROKER_TOKEN}` 在 settings、hook 或 MCP 配置中被替换；
- channel worker 的环境：supervisor 构建时剔除，worker 自己再清理一次；
- 控制面的 Runtime worker 过滤：现在也剔除 `QWEN_MANAGED_RUNTIME_BROKER_` 前缀。

daemon 自更新通过 `execve` 替换 `qwen serve`，PID 不变，systemd 不会再把这对变量交给替换进程。重启器只把已解析的这对值加进替换进程的环境（与 server token 并列），替换进程读取后再次删除。

否则，被提示注入的 agent 可以拿着 Broker token 直接调用 Broker。

### 固定端口

在 `--profile hosted-harness` 下，请求的端口出现 `EADDRINUSE` 时启动失败，并给出端口号。控制面的 `QWEN_MANAGED_AGENT_HARNESS_BASE_URL` 指向这个端口，Harness 一旦顺延，每个 Session 都会失败。`--port 0` 保持其临时端口的含义。随包 unit 每 5 秒重启一次失败的 Harness，因此端口持续冲突时，表现为 unit 不断重启，`journalctl -u qwen-hosted-harness` 中可以看到端口信息。

### 共享 Broker token

Harness 凭据文件增加两个可选键。当设置了 `harness.credentials-file` 且文件中有 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` 时，控制面从中取 `runtime-broker.token`。与另外两个键一样，文件设置了该键、同时又直接设置了 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` 时，启动失败。文件中没有该键时仍由直接配置决定，因此纯文本部署不受影响。Harness 还会从该文件读取 `QWEN_MANAGED_RUNTIME_BROKER_URL`，因此这两行都遵循与另外两个键相同的规则：`=` 两侧不留空白，值只用字母、数字和 `._:/+=-`；URL 还可以用 `[` 和 `]` 括住 IPv6 字面量，两种读取方都按字面读取它们。Harness 要求 URL 和 token 同时提供，并把空值视为已设置，因此只有其中一项、或其中一项为空的文件会导致启动失败。任何一行的键名中含有空白时都会导致启动失败：systemd 会忽略 shell 能够赋值的 `export KEY=value`，两种读取方读到的内容会不一致。绑定是原子的：发生冲突时什么都不会被绑定。

文件中的 Broker URL 是 Broker 绑定地址的第二份副本，而 Broker 的绑定地址由控制面单独配置。因此，在 Broker 已开启且启动时读取了该文件的情况下，预检增加一行 `broker-url`。这一行先按 Harness 启动时的方式读取 URL（`managed-runtime-broker-url.ts`）：先经 WHATWG URL 解析器，再套用 Harness 的规则，即 URL 必须是 `http` 或 `https` 的 origin，并且只有回环主机才允许明文 `http`；不满足时报 FAIL，因为 Harness 会拒绝启动。另写一个近似 Node 的解析器，会在两个方向上与 Node 不一致（`http://127.1:4182` 在 Node 看来就是回环 origin；`http://::1:4182` 和端口 99999 则根本不是 URL），因此 `HarnessBrokerUrl` 对凭据文件取值能触及的部分逐步照 URL Standard 实现：文件的字符集排除了百分号编码、用户信息、查询串、片段、反斜杠、空白和非 ASCII 文本，剩下的是协议、协议后的斜杠、IPv4/IPv6/ASCII 域名的主机解析、端口，以及路径中的点段。以 `xn--` 开头的标签需要 IDNA，它没有实现。IDNA 要么保留这种标签、要么拒绝整个 URL，所以这种主机永远不是回环地址：明文 `http` 或带路径时该行仍报 FAIL，只有 `https` 时才报 WARN（无法读取），因为只有这时结论完全取决于 IDNA。协议不是 `http` 或 `https` 时，在读取其余部分之前就拒绝，因此 Harness 判为无效的 URL（如 `ftp://`）可能以另一种理由报 FAIL；fixture 测试只允许这两种差异。`managed-runtime-broker-url.fixtures.json` 为每种写法记录一个判定，按预检的读法给出；只要 Harness 的 URL 解析器接受该主机，它也就是 Harness 的判定。CLI 测试用它检查 Harness，`HarnessBrokerUrlTest` 用它检查预检，任何一方的读取方式变化都会让其中一个测试失败。Node 的各代 URL 解析器对部分 `xn--` 标签的处理不一致。ada 2.9（Node 22）接受 `xn--localhost-`、拒绝 `xn--a`；ada 3（Node 24.0 至 24.19，以及 25）两者都拒绝；ada 4（Node 24.20 及以后，以及 26）两者都接受。因此，每个带 `xn--` 主机的用例都用 `idnaHost` 记下该主机，并记录解析器接受该主机时的判定，这也正是预检的读法。当前运行的解析器拒绝该主机时，CLI 测试期望 `invalid`，否则期望记录的判定。之后，只有当 URL 直接指向 Broker 自己的监听时，这一行才通过：协议为 `http`，端口为 `runtime-broker.port`，主机解析出的地址由该绑定提供，即 `runtime-broker.host` 本身，通配地址绑定时则为本机属于该绑定地址族的任一地址。JDK 只会以双栈 socket 绑定 `::`，因此它也服务 IPv4；但在 `-Djava.net.preferIPv4Stack=true` 下 JDK 只在 IPv4 上绑定 `0.0.0.0`，而服务端可能从预检看不到的环境里拿到这个 JVM 选项。因此指向 IPv4 通配绑定的 IPv6 URL 报 WARN，修复建议给出 IPv4 回环 URL。用 `https` 指向同一个监听时报 FAIL，因为嵌入式 Broker 提供的是明文 HTTP。其他 URL 报 WARN：它可能是转发到 Broker 的代理或 TLS 前端，预检无法确认，因此不会让 `--check` 失败。文件中没有 Broker URL 时同样报 WARN。Broker 绑定在回环或通配地址时，修复建议给出直连的回环 URL（按绑定解析出的地址构造，而不是照搬配置的写法）；否则指向 TLS 终止代理，因为 Harness 拒绝对非回环地址使用明文 `http`。Broker 绑定在回环以外的地址、却没有设置 `runtime-broker.allow-non-loopback` 时，`broker` 行同样报 FAIL，因为 Broker 本身会在启动时拒绝这种配置。

### 模板与文档

- bootstrap 把生成的 Broker token 以 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` 写入 `harness.env`，并在旁边写上 `QWEN_MANAGED_RUNTIME_BROKER_URL=http://127.0.0.1:4182`。`server.env` 不再包含该 token。
- `harness.env.example` 为工具路径列出这两个变量，默认注释掉。
- Harness unit 的 `ExecStart` 去掉 `$QWEN_HOSTED_HARNESS_BROKER_ARGS`，并删除因它而存在的单租户警告。
- 部署文档、systemd README（中英文）和 server README 说明这两个变量和固定端口，删去"端口顺延后更新 base URL"的说明，并提示升级的主机替换 `QWEN_HOSTED_HARNESS_BROKER_ARGS` 这一行。

## 兼容性与风险

- 通过命令行选项传参的部署不受影响；选项仍优先于对应的变量。
- 以前会顺延到空闲端口的 Hosted Harness，现在会启动失败。这个失败正是想要的信号；以前的行为会得到一个正在运行、却没有任何 Session 能访问的 Harness。
- 同时在 `harness.env` 和 `server.env` 中设置 Broker token 的部署，会在启动时失败，直到删掉其中一份。
- 已经没有任何组件读取 `QWEN_HOSTED_HARNESS_BROKER_ARGS`。升级的工具路径主机必须把这一行换成 `QWEN_MANAGED_RUNTIME_BROKER_URL` 和 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`；在此之前，Harness 启动时没有 Broker，`broker-url` 行会给出警告。控制面仍接受并忽略旧的那一行。
- bootstrap 写入的 Broker 两行没有注释掉，因此即使是纯文本部署，用其文件启动的 Harness 也会拿到一个 Broker 地址。Harness 只在工具路径的 Session 中才连接 Broker，所以在开启工具路径之前不会有任何连接。

## 验证计划

- CLI 单元测试：ACP 子进程、channel worker 和 core 的子进程环境都不含该 token，且 `${QWEN_MANAGED_RUNTIME_BROKER_TOKEN}` 占位符不会被替换；daemon 更新重启时把已解析的这对值交给替换进程。
- CLI 测试：端口被占用时 Hosted Harness profile 启动失败，而 default profile 仍顺延到下一个端口。
- Java 单元测试：
  - 可选的 Broker token 键能从文件解析出来；与直接配置冲突时失败且不绑定任何值；键缺失时保留直接配置的值；
  - Broker URL 和 token 所在行同样受凭据规则约束；
  - 直连的 `http` URL 时 `broker-url` 行通过；用 `https` 指向明文监听、URL 带路径、协议不是 `http(s)`、对非回环主机使用明文 `http` 时失败；Broker 端口或主机变更、换成另一个回环地址、IPv6 回环绑定配 IPv4 URL、IPv4 通配绑定配 IPv6 URL、以及其他端口上的 TLS 前端都报警告；非回环绑定时修复建议不会给出明文 `http`，且建议中的 URL 能够通过；
  - 对共享 fixture 中的每种写法，预检与 Harness 给出相同判定，包括 inet_aton 写法、缺少或多余的斜杠、点段、未加方括号的 IPv6 主机、八进制八位组、越界端口和带 `xn--` 标签的主机；
  - 凭据文件能绑定带方括号的 IPv6 URL，并拒绝只有 URL 或只有 token、URL 或 token 为空的文件以及 `export` 行；
  - broker 行只在启动读取了该文件时，才在修复建议中提到它；
  - Runtime worker 不继承该 token。
- 模板测试：`server.env` 不含 Broker token，`harness.env` 含两个变量，模板中两者均为注释状态，unit 加载 `harness.env` 且 `ExecStart` 不含 Broker 参数。
- 使用 bootstrap 文件的端到端测试：
  - Harness 从 `harness.env` 启动，不带 Broker 参数；
  - Harness 的 `/proc/<pid>/cmdline` 中没有 Broker token，Harness 的任何子进程也不带有它；
  - 工具路径的服务端能启动并完成一个 Turn；
  - 在同一端口上再启动一个 Harness 会启动失败。

## 验收标准

- 随包文件中没有任何一处把 Broker token 放在命令行上，且它只保存一份。
- Harness 启动的进程不继承该 token。
- Hosted Harness 端口被占用时启动停止，并给出端口号。
- 现有的命令行配置行为不变。

## 后续工作

在部署易用性系列中，除发布第一个 reference 预发布版外，没有其他计划中的后续工作。
