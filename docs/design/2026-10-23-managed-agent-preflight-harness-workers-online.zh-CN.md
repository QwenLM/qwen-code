# 预检：Harness 兼容性、遗留 worker 与在线模式

[English](2026-10-23-managed-agent-preflight-harness-workers-online.md) | [简体中文](2026-10-23-managed-agent-preflight-harness-workers-online.zh-CN.md)

状态：已提出，并在同一变更中实现。

## 问题

`bin/qwen-managed-agent-server --check` 有三处空白，运维在首次安装或升级时都会碰到。

- **Harness 兼容性。** `harness` 行只检查 `/capabilities` 在配置的 token 下能否返回 200。capability digest 不同、协议版本较旧，或者缺少 Workspace files 或 Shell 所需 lifecycle 的 Harness 都能通过；PASS 信息甚至写着"the digest is checked on the first Session"。随后控制面会拒绝每一个 Session，或者每一个工具 Session。
- **遗留 worker。** 控制面 unit 使用 `KillMode=process`，`systemctl stop` 之后 Runtime worker 仍在运行。部署文档要求在下一次启动前回收它们，而预检恰好就在这个时候运行，却什么也不说。
- **服务运行中。** 端口相关的行会绑定配置的地址，因此服务运行时 `--check` 会误报失败，运维根本无法在线上主机运行它。

## 目标

- `harness` 行执行与第一个 Session 相同的协商，并检查配置所要求的 Workspace 能力。
- Harness 运行的 Qwen Code 版本与发行包 `manifest.json` 写明的不同时，给出提示。
- 预检报告上次运行遗留、仍在运行的 Runtime worker。
- `--check --online` 可以在服务运行时执行，且不会误报失败。

## 非目标

- 由预检创建 Session 或运行 Turn。
- 结束 worker 进程。预检只报告它们。
- 检查 Harness 的可选 feature；缺少这些 feature 时，控制面会自行关闭相应功能。

## 设计

### Harness 兼容性

原有探测返回 200 之后，`harness` 行用配置的 base URL、token 和 digest 构造一个 `HostedHarnessClient`，随后关闭它。构造客户端时的协商与第一个 Session 完全相同：capabilities schema 1、REST transport、必需的 feature、Hosted Harness 协议 1、格式正确的 boot ID，以及相同的 capability digest。

- digest 不同时报 FAIL："advertises another capability digest"，修复建议给出 digest 对应的设置项，不打印具体值。
- 其他协商失败时报 FAIL，信息为客户端给出的原因，修复建议给出应安装的 Qwen Code 版本。
- 开启 Workspace files 时，Harness 不支持 lifecycle 协议 1 则报 FAIL。
- 开启 Workspace Shell 时，Harness 的 `lifecycleV2Profiles` 不含 `hosted-workspace-shell/1` 则报 FAIL，修复建议给出 `QWEN_HOSTED_LIFECYCLE_V2_PROFILES`。

PASS 信息为"compatible: Hosted Harness protocol 1, capability digest matches, Qwen Code `<version>`"。

版本号取自 capabilities 响应中的 `qwenCodeVersion`；期望版本取自 `manifest.json` 的 `compatibility.qwenCodeVersion`。预检通过 `java.class.path` 找到 manifest：launcher 运行的是 `java -jar lib/<jar>`，manifest 位于 `lib/` 旁边。由于协商已经通过，版本不同只报 WARN。开发环境的 classpath 或找不到 manifest 时，跳过这项比对。

### 遗留 worker

新增的 `workers` 行只在启用了 local-process Runtime 并配置了状态目录、且系统存在 `/proc` 时运行。worker 启动时以状态目录为工作目录，因此预检列出所有参数中含 `managed-runtime-worker`、且 `/proc/<pid>/cwd` 为该目录的进程。同一主机上其他部署的 worker 不会被匹配。

- 没有存活的 worker 时为 `PASS`。
- 有存活的 worker 时为 `WARN`，给出数量和 pid；修复建议为 `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server`，或结束这些 pid。
- 没有 local-process Runtime、没有 `/proc`，或状态目录尚不存在时为 `SKIP`。

这里报 WARN 而不是 FAIL，是因为持久模式的 Broker 可以接管它的 worker；不过部署文档仍要求升级前干净启动。

### 在线模式

`--online` 表示针对运行中的服务执行检查：

- `server-port` 和 `broker-port` 行改为连接配置的地址（通配地址映射为 `127.0.0.1`），而不是绑定它；有进程监听时通过，否则失败。
- `workers` 行跳过，因为运行中的服务端拥有它自己的 worker。

其余各行的行为不变。

## 失败语义

- digest 不一致、协商失败或缺少 lifecycle：`harness` 行失败，`--check` 退出码为 1。
- Qwen Code 版本与 manifest 不同：`harness` 行给出警告。
- 离线时状态目录中有存活的 worker：`workers` 行给出警告。
- `--online` 模式下某个端口无进程监听：对应的端口行失败。

## 兼容性与风险

- 以前能通过的 `harness` 行，现在可能失败。它报告的不一致原本会让每个 Session 失败，这里只是把失败提前了。
- 协商会再向 `/capabilities` 发一次请求，并在协商期间启动客户端的线程池。
- 运维本人的进程和 root 都能读取进程参数和 `/proc/<pid>/cwd`；以其他账号运行时，预检可能漏掉无法查看的 worker。

## 验证计划

- `ManagedAgentPreflightTest`：
  - 假的 `/capabilities` 返回完整响应时通过；
  - digest 不同时失败且不打印 digest；缺少必需 feature 时失败，并给出应安装的版本；
  - Qwen Code 版本不同时给出警告；
  - 缺少 Workspace 所需的 lifecycle 时失败，声明了 Shell profile 后通过；
  - 从 `lib/` 旁边读取 manifest，开发环境的 classpath 则忽略；
  - 使用真实进程：状态目录中的 worker、另一个目录中的 worker、状态目录中的非 worker 进程，只报告第一个；
  - `listeningCheck` 对正在监听的 socket 通过，对已关闭的端口失败；
  - `checks(--online)` 跳过 `workers`。
- 针对打包后的发行包和真实 Harness 的端到端测试：
  - `harness` 行通过；
  - 修改 Harness 的 digest 后失败；
  - `workers` 对遗留在状态目录中的 worker 给出警告；
  - 服务运行时 `--online` 通过。

## 验收标准

- 不兼容的 Harness 会在任何 Session 之前让 `--check` 失败，并给出原因。
- 上次运行遗留、仍在运行的 worker 会出现在 `--check` 的输出中。
- 对运行中的服务执行 `--check --online` 不会误报失败。

## 后续工作

在部署易用性系列中没有计划中的后续工作。
