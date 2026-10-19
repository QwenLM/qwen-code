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
install -m 0640 -o root -g qwen-managed-agent \
  ../config/application.example.yml /etc/qwen-managed-agent/application.yml
```

`harness.env` 与 `server.env` 中的 Harness token 和 capability digest 必须一致。

4. 安装并启动：

```bash
install -m 0644 qwen-hosted-harness.service \
  qwen-managed-agent-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qwen-hosted-harness qwen-managed-agent-server
```

`qwen` 未安装在 `/usr/local/bin` 时，请调整 Harness unit 的 `ExecStart`。

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

## 路径

- `/opt/qwen-managed-agent` — 解压后的分发产物（只读）。
- `/etc/qwen-managed-agent` — 凭据与 `application.yml`。
- `/var/lib/qwen-managed-agent` — Runtime 状态。
- `/srv/qwen-workspace` — Workspace；迁移位置时同步调整 `ReadWritePaths`。
