# 预检：Harness 兼容性、遗留 worker 与在线模式

[English](2026-10-23-managed-agent-preflight-harness-workers-online.md) | [简体中文](2026-10-23-managed-agent-preflight-harness-workers-online.zh-CN.md)

状态：已提出，并在同一变更中实现。

## 问题

`bin/qwen-managed-agent-server --check` 有几处空白，运维在首次安装或升级时都会碰到。

- **Harness 兼容性。** `harness` 行只检查 `/capabilities` 在配置的 token 下能否返回 200。capability digest 不同、协议版本较旧，或者缺少某个 Workspace profile 所需 lifecycle 的 Harness 都能通过；PASS 信息甚至写着"the digest is checked on the first Session"。随后控制面会拒绝每一个 Session，或者每一个工具 Session。
- **遗留 worker。** 控制面 unit 使用 `KillMode=process`，`systemctl stop` 之后 Runtime worker 仍在运行。部署文档要求在下一次启动前回收它们，而预检恰好就在这个时候运行，却什么也不说。
- **服务运行中。** 端口相关的行会绑定配置的地址，因此服务运行时 `--check` 会误报失败，运维根本无法在线上主机运行它。
- **服务刚停止。** 端口相关的行绑定时不带 `SO_REUSEADDR`。停止后大约一分钟内，服务端留在 `TIME_WAIT` 的端口会让这些行失败，而 Tomcat 和 Broker 的 `HttpServer` 都能正常绑定。

## 目标

- `harness` 行执行与第一个 Session 相同的协商，并检查每个已配置的 Workspace profile 所需的 lifecycle。
- Harness 运行的 Qwen Code 版本与发行包 `manifest.json` 写明的不同，或者 Harness 没有说明自己的版本时，给出提示。
- 预检报告上次运行遗留、仍在运行的 Runtime worker。
- `--check --online` 可以在服务运行时执行，且不会误报失败。
- 离线端口行对 `TIME_WAIT` 中端口的判断与服务端一致。

## 非目标

- 由预检创建 Session 或运行 Turn。
- 结束 worker 进程。预检只报告它们。
- 与 Harness pool 的每个端点协商。开启 `harness.pool.enabled` 时，只有在 Session Store 已启用且配置了 binding key 后，`harness` 行才对 pool 的端点 SKIP，否则为 FAIL；pool 的就绪状态在启动后确认。
- 检查 Harness 的可选 feature。缺少大多数这类 feature 时，控制面会自行关闭相应功能。唯一不能关闭的是 `workspace-shell-mcp/1`：缺少它时，固定了 MCP server 的 Shell Session 会失败。由于预检看不到哪些 agent 固定了 MCP server，这种情况只报 WARN。

## 设计

### Harness 兼容性

原有探测返回 200 之后，`harness` 行用配置的 base URL、token 和 digest 构造一个 `HostedHarnessClient`，随后关闭它。构造客户端时的协商与第一个 Session 完全相同：capabilities schema 1、REST transport、必需的 feature、Hosted Harness 协议 1、格式正确的 boot ID，以及相同的 capability digest。

各类失败分别报告：

- digest 不同时报 FAIL："advertises another capability digest"，两边的值都不打印。使用凭据文件时，修复建议指向文件中的 `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST`，两端都读取它；不使用凭据文件时，修复建议同时给出两个变量：Harness 的 `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` 和控制面的 `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST`。
- 协商自身的请求遇到传输失败、客户端饱和或 HTTP 错误时报 FAIL："did not answer the compatibility request"，或"answered the compatibility request with HTTP `<status>`"，修复建议为重试。401 或 403 与探测一样，指向 token 设置。只打印状态码，从不打印响应正文。
- 客户端无法使用的 base URL（例如带凭据的 URL）报 FAIL，并指出 `QWEN_MANAGED_AGENT_HARNESS_BASE_URL`。
- 其他协商失败属于协议不匹配，报 FAIL，信息为客户端给出的原因，修复建议给出应安装的 Qwen Code 版本。

所有信息中的 URL 都去掉了用户信息。来自 Harness 的文本（例如客户端消息）会替换掉控制字符，并截断为 200 个字符。

随后，部署可能接纳的每个 Workspace profile 都要求对应的 lifecycle，判断规则与 connector 相同，即 `WorkspaceToolProfiles.lifecycleProtocol`。这些 profile 包括：开启 Workspace files 时的 `hosted-workspace-files/1` 和 `definition-tool-profiles` 中的每一项，以及开启 Shell 时的 `hosted-workspace-shell/1`。

- 协议 1 的 profile 要求 Harness 支持 lifecycle 协议 1，否则报 FAIL，修复建议给出应安装的版本。
- 协议 2 的 profile 要求出现在 `lifecycleV2Profiles` 中，否则报 FAIL。
  - 修复建议是把它加入 `QWEN_HOSTED_LIFECYCLE_V2_PROFILES`。
  - 显式设置的值会替换整个列表，所以修复建议给出应设置的完整列表：先是 Harness 已提供的协议 2 profile，再是部署需要的。
- 不属于这两个协议的 profile（例如 `hosted-workspace-files/3`）不检查。

PASS 信息为"compatible: Hosted Harness protocol 1, capability digest matches, Qwen Code `<version>`"。以下三种情况报 WARN，修复建议给出应安装的版本：

- capabilities 响应中的 `qwenCodeVersion` 与 `manifest.json` 的 `compatibility.qwenCodeVersion` 不同；
- manifest 写明了版本，而响应中没有 `qwenCodeVersion`，或者它不是普通的版本号（`[0-9A-Za-z.+-]{1,64}`）；
- 开启了 Shell，而 `hostedHarness.features` 中没有 `workspace-shell-mcp/1`。

预检使用与 `database` 行相同的方法查找 manifest：取 classpath 中第一个在其 `lib/` 目录旁有 `manifest.json` 的 jar，找不到时退回服务端 jar 自身所在的位置。没有 manifest 时不比对版本。

### 遗留 worker

新增的 `workers` 行只在启用了 local-process Runtime 并配置了状态目录、且系统存在 `/proc` 时运行。不运行时，在线和离线给出的原因相同。

- **匹配。** worker 以 `node <entry> managed-runtime-worker` 的形式运行，以状态目录为工作目录。因此预检只匹配同时满足以下两点的进程：
  - 可执行文件名以 `node` 开头，最后一个参数是 `managed-runtime-worker`，且前一个参数是绝对路径；
  - `/proc/<pid>/cwd` 是状态目录的真实路径。

  目录被删除后，内核会在该路径后加上" (deleted)"。预检会去掉这个后缀，因此仍停留在被删除后重建的目录中的 worker 依然能匹配。预检自身的进程不会被匹配。同一主机上其他部署的 worker，以及只是在参数中提到该标记的诊断命令，也不会被匹配。

- **离线时的结果：**
  - 没有存活的 worker 时为 `PASS`。
  - 有存活的 worker 时为 `WARN`，给出数量和 pid。没有持久模式 Broker 时，修复建议为 `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server`，或结束这些 pid。持久模式的 Broker 会在启动时接管它的 worker，修复建议会说明这一点，并只在需要干净启动（例如升级）时才回收。
  - 没有 local-process Runtime、没有 `/proc`，或状态目录尚不存在时为 `SKIP`。
  - 状态目录存在但无法解析（例如权限不足）时为 `WARN`，因为预检此时无法判断。
  - 某个进程的 argv 指向 worker、但无法检查它（例如它属于另一个账号，读取它的 `/proc` 条目需要调用者的 ptrace 权限）时为 `WARN`。若同一次扫描既发现了遗留进程又有无法检查的进程，则同时给出存活 pid 与无法检查的数量，绝不把不完整的列表当成完整结果。

这里报 WARN 而不是 FAIL，是因为持久模式的 Broker 可以接管它的 worker；不过部署文档仍要求升级前干净启动。

### 在线模式

`--online` 或 `--online=true` 表示针对运行中的服务执行检查，`--online=false` 按离线检查。`--online=` 取其他值时会让 `online` 行失败，其余各行仍按离线执行，因此端口与 worker 行可能报告运行中服务自身的状态。

- `server-port` 和 `broker-port` 行改为连接配置的地址（通配地址映射为 `127.0.0.1`），而不是绑定它；有进程监听时通过。主机无法解析时报"cannot resolve"，连接失败时给出原因。
- `workers` 行的行为取决于 Broker：
  - 持久模式的 Broker 会接管存活的 worker，在线时无法把它们与遗留的 worker 区分开，因此以这个原因 SKIP。
  - 非持久模式的 Broker，报告父进程不是 Java 进程的匹配 worker。这些是被 `KillMode=process` 交给 init 的孤儿进程，而不是运行中服务端的子进程。

其余各行的行为不变。离线时，端口被占用的修复建议会提到 `--check --online`。

### 离线端口行

离线端口行绑定时使用 JDK 默认的 `SO_REUSEADDR`，与 Tomcat 和 JDK `HttpServer` 一致。已停止的服务端留在 `TIME_WAIT` 的端口可以通过，而有进程监听时，Linux 仍会拒绝绑定。

## 失败语义

- 以下情况 `harness` 行失败，`--check` 退出码为 1：
  - digest 不一致或其他协商失败；
  - 兼容性请求没有得到应答；
  - base URL 不可用；
  - 缺少 lifecycle。
- Qwen Code 版本与 manifest 不同、Harness 没有可读的版本号，或开启 Shell 时缺少 `workspace-shell-mcp/1`：`harness` 行给出警告。
- 离线时状态目录中有存活的 worker、非持久模式下在线检查发现孤儿 worker，或状态目录无法解析：`workers` 行给出警告。
- `--online` 模式下某个端口无进程监听：对应的端口行失败。`--online=` 取 `true`、`false` 以外的值：`online` 行失败。

## 兼容性与风险

- 以前能通过的 `harness` 行，现在可能失败。它报告的不一致原本会让每个 Session（或该 profile 的每个 Session）失败，这里只是把失败提前了。
- 协商会再向 `/capabilities` 发一次请求，并在协商期间启动客户端的线程池。
- 运维本人的进程和 root 都能读取进程参数和 `/proc/<pid>/cwd`；以其他账号运行时，预检可能漏掉无法查看的 worker。
- 在线模式把父进程是 Java 进程的 worker 视为运行中服务端的 worker。如果已停止的服务端的 worker 被交给了另一个 Java 进程（例如容器中作为 pid 1 的 Java），在线模式会漏掉它们；离线行仍能报告。

## 验证计划

- `ManagedAgentPreflightTest`，`harness` 行：
  - 假的 `/capabilities` 返回完整响应时通过；
  - digest 不同时失败且不打印 digest，不使用凭据文件时同时给出两个变量；
  - 缺少必需 feature 时失败，并给出应安装的版本；没有版本时给出 manifest 的兜底说法；
  - 第二次请求被丢弃或失败时，报告的是请求失败而不是 Harness 不兼容，且不包含响应正文；
  - 带凭据的 base URL 不会把凭据写进报告；
  - 版本不同、缺少版本或版本格式不对，以及缺少 `workspace-shell-mcp/1` 时给出警告；
  - 缺少 lifecycle 时失败（包括 definition 中的 MCP profile），且修复建议保留了 Harness 已提供的 profile；
  - 探测和协商都发送了配置的 token。
- `ManagedAgentPreflightTest`，manifest：classpath 中有多个 jar 时也能找到。
- `ManagedAgentPreflightTest`，`workers` 行，使用真实进程：
  - 状态目录中的 worker 会被报告；其他目录中的 worker、非 worker 进程、缺少入口参数的仿冒进程，以及参数中带标记的 `tail` 都不会；
  - 持久与非持久模式的修复建议不同；
  - 在线时，持久模式的 Broker 为 SKIP，仍有父进程的 worker 通过，孤儿 worker 被报告；
  - 预检进程不会计入自身；
  - 通过符号链接配置的状态目录，以及删除后重建的状态目录，都能匹配；
  - 目录不存在时 SKIP，无法解析时 WARN。
- `ManagedAgentPreflightTest`，端口行：
  - `listeningCheck` 对正在监听的 socket 通过，对已关闭的端口或无法解析的主机失败；
  - `checks()` 接受 `--online=true`、拒绝其他取值，并在在线时检查 Broker 端口；
  - 离线时端口被占用的修复建议提到 `--online`；
  - `TIME_WAIT` 中的端口通过，而有进程监听时仍失败。
- 针对打包后的发行包和真实 Harness 的端到端测试：
  - `harness` 行通过；
  - 修改 Harness 的 digest 后失败；
  - `workers` 对遗留在状态目录中的 worker 给出警告；
  - 服务运行时 `--online` 通过。

## 验收标准

- 不兼容的 Harness 会在任何 Session 之前让 `--check` 失败，并给出原因。
- 上次运行遗留、仍在运行的 worker 会出现在 `--check` 的输出中。
- 对运行中的服务执行 `--check --online` 不会误报失败。
- 刚停止服务后执行 `--check` 不会误报端口失败。

## 后续工作

本改动没有后续工作。
