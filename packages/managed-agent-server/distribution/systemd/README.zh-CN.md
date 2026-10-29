# systemd unit

[English](README.md) | [简体中文](README.zh-CN.md)

面向已接受的单机拓扑：同一台可信 Linux 主机上运行一个 Hosted Harness、一个 Java 控制面与 MySQL。这两个 unit 只管理 Harness 与控制面，MySQL 不在其范围内。启用前请逐项核对路径与服务账号。

## 安装

1. 把分发产物解压到 `/opt/qwen-managed-agent`。
2. 创建服务账号与目录：

```bash
useradd --system --home /var/lib/qwen-managed-agent \
  --shell /usr/sbin/nologin qwen-managed-agent
install -d -o qwen-managed-agent -g qwen-managed-agent /srv/qwen-workspace
install -d -m 0750 -o root -g qwen-managed-agent /etc/qwen-managed-agent
```

3. 安装环境文件与密钥环，并编辑这三个文件。以下命令在本 `systemd/` 目录中执行：

```bash
install -m 0600 -o qwen-managed-agent -g qwen-managed-agent \
  harness.env.example /etc/qwen-managed-agent/harness.env
install -m 0640 -o root -g qwen-managed-agent \
  server.env.example /etc/qwen-managed-agent/server.env
install -m 0600 -o qwen-managed-agent -g qwen-managed-agent \
  ../config/application.example.yml /etc/qwen-managed-agent/application.yml
```

控制面以 `qwen-managed-agent` 身份读取 `application.yml` 和 `harness.env`，因此这两个文件由服务账号拥有、权限 `0600`。含 secret 的文件对 group 或 others 可读时，预检会在 `config` 和 `credentials` 行给出警告；WARN 不会让 `--check` 失败，请执行它给出的 `chmod 600`。`root` 拥有的 `0600` `harness.env` 服务读不到，`credentials` 行会将其报告为 FAIL。`server.env` 设置了 `QWEN_MANAGED_AGENT_SERVICE_USER=qwen-managed-agent`，因此即使以 root 身份运行 `--check`，这两行也按该账号检查访问权限，包括文件路径上以及任何符号链接目标路径上的每一级目录；`service-user` 行会显示该账号及其所属组。`systemd` 以 root 读取环境文件，因此 `server.env` 保持 `0640 root:qwen-managed-agent` 即可。

Harness token 和 capability digest 只保存在 `harness.env` 中：`server.env` 通过 `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE` 指向它；若该文件与 `QWEN_MANAGED_AGENT_HARNESS_TOKEN` 或 `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST` 同时设置，或其中的 Broker token 与 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` 同时设置，控制面会拒绝启动。`harness.env` 中的每项凭据和 Broker URL 都应在一行内写成 `KEY=value`，使用 LF 换行，`=` 两侧不留空白，值只用字母、数字和 `._:/+=-`（Broker URL 还可以用 `[` 和 `]` 括起 IPv6 字面量，例如 `http://[::1]:4182`），注释以 `#` 开头。其余写法（例如续行、`;` 注释或闭引号之后的文字）都会被控制面拒绝，因为 systemd 或 shell 会以不同方式读取它们。开启工具路径时，取消 `harness.env` 中 `QWEN_MANAGED_RUNTIME_BROKER_URL` 和 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` 的注释。控制面从同一文件读取该 token，因此 `server.env` 不含 Broker token。升级的主机请把 `QWEN_HOSTED_HARNESS_BROKER_ARGS` 行换成这两行：已经没有组件读取它。Harness 不会离开端口 4170：端口被占用时，它会退出，而不是运行在 `QWEN_MANAGED_AGENT_HARNESS_BASE_URL` 访问不到的端口上；systemd 每 5 秒重启一次，`journalctl -u qwen-hosted-harness` 中可以看到端口信息。Session Store 无需单独配置：控制面从自己的监听推导其 URL（不随 Harness 端口变化），并从 `QWEN_MANAGED_AGENT_WORKSPACE_CWD`（即上文创建的目录）推导其 workspace ID。

也可以以 root 身份一次生成这三个文件，并直接设好上述属主与权限：

```bash
../bin/qwen-managed-agent-bootstrap --directory /etc/qwen-managed-agent \
  --service-user qwen-managed-agent
mysql -u root < /etc/qwen-managed-agent/mysql-setup.sql
rm /etc/qwen-managed-agent/mysql-setup.sql
```

bootstrap 还会生成数据库密码并写入 `server.env`，同时写出只有 root 可读的 `mysql-setup.sql`，用于创建数据库及其账号。

4. 安装并启动：

```bash
install -m 0644 qwen-hosted-harness.service \
  qwen-managed-agent-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qwen-hosted-harness qwen-managed-agent-server
```

`qwen` 未安装在 `/usr/local/bin` 时，请调整 Harness unit 的 `ExecStart`。两个 unit 都设置了 `ProtectHome=true`，因此 `qwen` 解析到的可执行文件必须位于 `/home`、`/root`、`/run/user` 之外；若 `/usr/local/bin/qwen` 是指向 home 目录的软链接，unit 会以 `203/EXEC` 失败。可用 `readlink -f "$(command -v qwen)"` 检查。

## 验证

加载 unit 使用的同一份环境文件，并在服务停止时运行预检：

```bash
sudo systemd-run --wait --pipe --collect \
  --property=User=qwen-managed-agent \
  --property=EnvironmentFile=/etc/qwen-managed-agent/server.env \
  /opt/qwen-managed-agent/bin/qwen-managed-agent-server --check
curl --fail http://127.0.0.1:8080/actuator/health
```

`--check` 会实际绑定配置端口，其 `workers` 行还会对上次启动遗留、仍在运行的 Runtime worker 给出警告，因此请在服务停止时运行。服务运行期间请加上 `--online`：端口相关的行改为检查服务端与 Broker 是否在监听；`workers` 行只报告已停止的服务端遗留的 worker，对持久模式的 Broker 则跳过，因为它会接管这些 worker。

## 两处 kill mode 的差异

控制面使用 `KillMode=process`，使 Broker 重启时 Runtime worker 继续存活；默认的 `control-group` 会把它们随服务一起终止。Harness 使用 `KillMode=mixed`，其工具进程随它终止。除非改用等价监管方式，否则保留这两项设置。

同一项 `KillMode=process` 也意味着 `systemctl stop qwen-managed-agent-server` 只向主进程发送信号：unit 报告 inactive 时 Runtime worker 仍在运行并持有状态目录与 Workspace，随后启动会与它们竞争。重启前先回收：`systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server`。

## 路径

- `/opt/qwen-managed-agent` — 解压后的分发产物（只读）。
- `/etc/qwen-managed-agent` — 凭据与 `application.yml`。
- `/var/lib/qwen-managed-agent` — Runtime 状态。
- `/srv/qwen-workspace` — Workspace；迁移位置时同步调整 `ReadWritePaths`。

## Extension 执行

执行默认关闭。先单独启用包发布，再配置
`QWEN_MANAGED_AGENT_EXTENSION_EXECUTION_ENABLED=true`、
`QWEN_MANAGED_AGENT_EXTENSION_EXECUTION_MODE=linux-cgroup`、位于 Workspace 存储之外的绝对私有
`QWEN_MANAGED_AGENT_EXTENSION_CACHE_DIRECTORY`，并将
`QWEN_MANAGED_AGENT_EXTENSION_CGROUP_ROOT` 指向每台 LOCAL 或 SSH Runtime 主机上可写、已委派的
cgroup-v2 子树。管理员必须为服务委派 cgroup；普通可写目录不足以提供此能力。
缺少 cgroup 支持时激活失败，不回退到进程组。

macOS 原生 LOCAL 必须显式选择 `developer-process-group` 且清空 cgroup root。
该模式的回执仅证明已登记进程组，不证明已脱离进程组的后代被回收，不属于生产进程树监管配置。
持久 owner journal 或停止证明缺失、不确定时，恢复继续保留 hold。
