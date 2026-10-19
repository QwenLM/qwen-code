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
install -m 0640 -o root -g qwen-managed-agent \
  harness.env.example /etc/qwen-managed-agent/harness.env
install -m 0640 -o root -g qwen-managed-agent \
  server.env.example /etc/qwen-managed-agent/server.env
install -m 0600 -o qwen-managed-agent -g qwen-managed-agent \
  ../config/application.example.yml /etc/qwen-managed-agent/application.yml
```

控制面以 `qwen-managed-agent` 身份读取 `application.yml`，因此该文件由服务账号拥有、权限 `0600`。预检会拒绝 group 或 others 可读的含 secret 文件；而 `root` 拥有的 `0600` 文件服务同样读不到。`systemd` 以 root 读取两个环境文件，因此它们保持 `0640 root:qwen-managed-agent` 即可。

`harness.env` 与 `server.env` 中的 Harness token 和 capability digest 必须一致。若 `qwen serve` 因 4170 被占用而报告了其他端口，请在启动控制面前把 `server.env` 中的 `QWEN_MANAGED_AGENT_HARNESS_BASE_URL` 改为实际端口。`QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL` 是另一个值：它指向本 Java 控制面自己的监听端口（模板中为 `http://127.0.0.1:8080`），不随 Harness 端口变化。

也可以运行 `../bin/qwen-managed-agent-bootstrap --directory /etc/qwen-managed-agent` 生成这三个文件，随后调整属主与权限。

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

`--check` 会实际绑定配置端口，服务运行期间运行会得到误报的失败。

## 两处 kill mode 的差异

控制面使用 `KillMode=process`，使 Broker 重启时 Runtime worker 继续存活；默认的 `control-group` 会把它们随服务一起终止。Harness 使用 `KillMode=mixed`，其工具进程随它终止。除非改用等价监管方式，否则保留这两项设置。

同一项 `KillMode=process` 也意味着 `systemctl stop qwen-managed-agent-server` 只向主进程发送信号：unit 报告 inactive 时 Runtime worker 仍在运行并持有状态目录与 Workspace，随后启动会与它们竞争。重启前先回收：`systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server`。

## 路径

- `/opt/qwen-managed-agent` — 解压后的分发产物（只读）。
- `/etc/qwen-managed-agent` — 凭据与 `application.yml`。
- `/var/lib/qwen-managed-agent` — Runtime 状态。
- `/srv/qwen-workspace` — Workspace；迁移位置时同步调整 `ReadWritePaths`。
