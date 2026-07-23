# Qwen Code Benchmark Worker

Qwen Code 发版后 Benchmark 的单机 ECS 执行服务。当前 POC 已打通：

```text
GitHub Release / workflow_dispatch
  -> GitHub Actions self-hosted runner
  -> 本机 dispatcher
  -> qwen-benchmark-submit CLI
  -> SQLite
  -> systemd worker
  -> Harbor + Docker + Qwen Code Agent + verifier
  -> GitHub Release / Check Run
```

本仓库只包含 Benchmark submit CLI、worker、Harbor 适配、状态存储、部署模板和测试，不包含 Qwen Code 源码、模型密钥、GitHub PAT、运行数据库、trajectory 或历史评测产物。

## 1. 设计目标

- 将 Qwen Code Release 与 SWE-bench 类 Benchmark 串成可重复的流水线。
- 将 Release tag、npm package、实际 Agent 版本和不可变 commit 对齐。
- GitHub Actions 只负责派发，不占用 runner 等待数小时。
- ECS worker 独立维护任务状态、heartbeat、retry、产物和终态回写。
- 成功任务公开有效分数；失败任务只公开 failed，不发布误导性分数。
- raw trajectory、模型密钥、内部日志和运行环境信息始终留在 ECS/私有 OSS。

当前实现定位为单机 POC，不是最终的 50 并发生产调度器。

## 2. 核心组件

### Submit CLI

入口为 `qwen-benchmark-submit`。GitHub self-hosted runner 与 worker 位于同一台 ECS，因此任务不经过 HTTP 服务，CLI 直接校验参数并写入本机 SQLite。

CLI 负责：

- 校验仓库、Release ref、commit 和 trigger。
- 校验 suite allowlist。
- 生成或接受 idempotency key。
- 初始化 SQLite schema。
- 创建 run 和 instance manifest。
- 返回 `run_id`、初始状态和是否命中幂等记录。

相同 idempotency key 不会创建重复任务。CLI 不读取模型 key 或 GitHub token，也不需要 shared token。

### SQLite 状态库

SQLite 使用 WAL 模式，保存：

- `runs`：版本、suite、run 状态、attempt、heartbeat 和汇总结果。
- `instances`：每个 case 的状态。
- `events`：状态变化及恢复事件。

SQLite 是 POC 的任务队列和状态库。当前不依赖 RocketMQ、Kafka 或 Redis。

### Worker

`qwen-benchmark-worker` 是常驻 systemd 服务：

1. 按创建时间领取一个 `QUEUED` run。
2. 冻结 suite 和实例清单。
3. 选择 gold、原生 SWE-bench 或 Harbor runner。
4. 更新 heartbeat 和实例状态。
5. 收集 grader、Harbor、trajectory 和汇总产物。
6. 将 run 转为唯一终态。
7. 成功或终态失败后回写 GitHub。

worker 重启时会检查中断任务。基础设施型中断在 attempt 未耗尽时重新入队，否则标记为 `FAILED`。

### Harbor runner

Harbor 模式执行：

```text
harbor run
  --dataset <dataset@revision>
  --include-task-name <instance>
  --agent qwen-coder
  --model <OPENAI_MODEL>
  --agent-kwarg version=<Qwen Code npm version>
  --env docker
```

运行前会确认 `@qwen-code/qwen-code@<version>` 已在 npm registry 可见，并在结果解析阶段校验 Harbor 实际记录的 Qwen Code Agent 版本。

每个 case 使用独立 Docker testbed。Docker 镜像可以共享节点缓存，但运行容器和任务产物互相隔离。

### GitHub publisher

终态回写包括：

- 更新触发该任务的 GitHub Release。
- 为对应 Qwen Code commit 创建 Check Run。

成功结果公开：

- dataset 和 revision
- suite 和评测方式
- expected/completed case 数
- resolved/unresolved/infra error 数
- 百分比分数
- Qwen Code 版本和 commit
- ECS run ID

失败结果只显示 `Failed — not scored`，不发布数值分数。Release 中使用固定 marker，重跑会替换旧结果，不会无限追加。

## 3. 执行状态

主状态流：

```text
QUEUED
  -> PREPARING
  -> RUNNING_AGENT
  -> GRADING
  -> UPLOADING
  -> SUCCEEDED
```

异常终态：

```text
FAILED
CANCELED
```

只有 manifest 中全部预期实例都得到终态、结果数量校验通过，run 才能进入 `SUCCEEDED`。

## 4. Retry 边界

自动 retry 只用于基础设施问题，例如：

- worker 进程或节点异常退出
- Docker/Harbor 启动失败且没有产生有效 trial
- npm/网络等外部依赖暂时不可用
- grader 未返回完整 manifest

以下结果不自动 retry：

- Agent 正常完成但没有解决问题
- verifier 判定未通过
- 正常达到任务 timeout
- 有效的 unresolved 结果

POC 默认 `max_attempts=2`，即首次执行加一次基础设施重试。

## 5. 当前并发模型

当前 ECS POC 是串行执行：

- 一个 systemd worker 进程。
- worker 同时领取一个 run。
- Harbor runner 逐个遍历 suite 中的 case。
- 每个 case 单独启动一次 `harbor run`。
- Harbor 参数为 `--n-concurrent 1`。

因此当前不是一个 Harbor 管理全部并发任务，也不是多个 Harbor 同时运行。

生产扩展建议由外层调度器控制全局并发，将数据集切成 shard；每个 shard 启动独立 Harbor 进程，并在 Harbor 内使用小规模 `--n-concurrent`。例如：

```text
10 个 shard x 每个 Harbor 并发 5 = 全局 50 case
```

不建议单个 Harbor 进程管理全部 500 个 case，否则单进程失败、超时和 retry 的影响范围过大。

## 6. 内置 suites

suite 定义在 `qwen_benchmark/suites.json`。

### `swebench_verified_gold_smoke`

- 使用 SWE-bench Verified gold patch。
- 不消耗模型 token。
- 用于验证 Docker、数据集、grader、SQLite 和产物链路。
- 结果不能作为 Qwen Code Agent 分数。

### `swebench_verified_qwen_smoke`

- 使用本地 Qwen Code 源码和原生 SWE-bench harness。
- 通过独立 git worktree 固定到目标 commit。

### `swebench_verified_harbor_smoke`

- 使用开源 Harbor Framework。
- 从 Release tag 推导并安装对应 Qwen Code npm 版本。
- 使用 `qwen-coder` Agent 和 Docker 环境。
- 当前包含 `sympy__sympy-20590` 单 case。

扩展正式 suite 时应固定：

- dataset 和 revision
- instance manifest
- Qwen Code release/commit
- Agent/Harbor 配置
- model
- timeout、最大 turns 和并发度

## 7. 目录结构

```text
qwen_benchmark/
  submit.py           本机幂等任务提交 CLI
  config.py           环境配置和 suite 类型
  store.py            SQLite、状态机和恢复
  worker.py           常驻 worker 和终态处理
  harbor_runner.py    Harbor/Qwen Code npm 版本适配
  runner.py           gold 和原生 SWE-bench runner
  publisher.py        GitHub Release/Check 回写
  artifacts.py        产物收集和 checksum
  suites.json         allowlisted suite manifest

deploy/
  systemd/            ECS worker systemd unit
  qwen-benchmark-dispatch
                      self-hosted runner 本地派发脚本
  qwen-benchmark-dispatch.sudoers
                      最小 sudo 权限
  benchmark.ecs.env   ECS 非敏感配置模板
  benchmark.env.example
                      通用配置模板
tests/                submit、worker、Harbor 和 publisher 测试
```

## 8. 本地开发

要求：

- Python 3.12+
- Docker
- git
- `jq` 和 `curl`
- 运行 Harbor suite 时安装 Harbor Framework

创建环境：

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e '.[test]'
```

运行测试：

```bash
PYTHONPATH=. .venv/bin/pytest -q
```

当前代码基线预期：

```text
12 passed
```

本地启动：

```bash
export BENCHMARK_ROOT="$PWD/.state"
export BENCHMARK_DATABASE_PATH="$PWD/.state/benchmark.db"
export BENCHMARK_WORK_ROOT="$PWD/.work"
export BENCHMARK_ARTIFACT_ROOT="$PWD/.artifacts"
export BENCHMARK_QWEN_REPO=/path/to/qwen-code
export BENCHMARK_SWEBENCH_PYTHON="$PWD/.venv/bin/python"
.venv/bin/qwen-benchmark-worker
```

另一个终端可直接提交 smoke run：

```bash
.venv/bin/qwen-benchmark-submit \
  --repository QwenLM/qwen-code \
  --qwen-ref v0.20.0 \
  --qwen-commit 0123456789abcdef0123456789abcdef01234567 \
  --suite swebench_verified_gold_smoke \
  --trigger manual \
  --idempotency-key local-gold-smoke-1
```

## 9. ECS 部署

推荐目录：

```text
/srv/qwen-benchmark/
  config/
    benchmark.env
    benchmark.secret.env
  state/
    benchmark.db
  artifacts/
  workspaces/
  harbor/jobs/
  cache/
  src/
    qwen-code/
    qwen-code-benchmark-worker/
  venv/
```

安装：

```bash
sudo mkdir -p /srv/qwen-benchmark/{config,state,artifacts,workspaces,harbor/jobs,cache,src}
sudo chown -R ecs-user:ecs-user /srv/qwen-benchmark

python3.12 -m venv /srv/qwen-benchmark/venv
/srv/qwen-benchmark/venv/bin/pip install -e '/srv/qwen-benchmark/src/qwen-code-benchmark-worker[test]'
```

复制配置：

```bash
sudo install -o root -g root -m 0644 \
  deploy/benchmark.ecs.env \
  /srv/qwen-benchmark/config/benchmark.env

sudo install -o root -g root -m 0600 /dev/null \
  /srv/qwen-benchmark/config/benchmark.secret.env
```

`benchmark.secret.env` 仅供 worker 读取，按需要设置：

```text
BENCHMARK_GITHUB_TOKEN=<GitHub App installation token or scoped PAT>
```

模型凭证建议使用独立 root-only EnvironmentFile，不要写入仓库或普通配置模板。

安装 worker 服务：

```bash
sudo install -m 0644 deploy/systemd/qwen-benchmark-worker.service \
  /etc/systemd/system/qwen-benchmark-worker.service

sudo systemctl daemon-reload
sudo systemctl enable --now qwen-benchmark-worker.service
```

安装 self-hosted runner dispatcher：

```bash
sudo install -o root -g root -m 0750 \
  deploy/qwen-benchmark-dispatch \
  /usr/local/sbin/qwen-benchmark-dispatch
sudo install -o root -g root -m 0440 \
  deploy/qwen-benchmark-dispatch.sudoers \
  /etc/sudoers.d/qwen-benchmark-dispatch
sudo visudo -cf /etc/sudoers.d/qwen-benchmark-dispatch
```

## 10. 配置项

常用非敏感配置：

| 配置 | 说明 |
| --- | --- |
| `BENCHMARK_DATABASE_PATH` | SQLite 路径 |
| `BENCHMARK_WORK_ROOT` | 临时工作目录 |
| `BENCHMARK_ARTIFACT_ROOT` | 汇总产物根目录 |
| `BENCHMARK_QWEN_REPO` | 本机 Qwen Code repo/cache |
| `BENCHMARK_HARBOR_BINARY` | Harbor CLI 路径 |
| `BENCHMARK_HARBOR_JOBS_ROOT` | Harbor jobs 目录 |
| `BENCHMARK_NPM_REGISTRY` | Qwen Code npm 查询/安装 registry |
| `BENCHMARK_NPM_WAIT_SECONDS` | 等待 npm Release 可见的上限 |
| `BENCHMARK_POLL_SECONDS` | worker 空闲轮询间隔 |
| `BENCHMARK_ALLOWED_REPOSITORY` | 允许触发的 GitHub 仓库 |
| `OPENAI_BASE_URL` | 模型 API endpoint |
| `OPENAI_MODEL` | Benchmark 模型 |

敏感配置：

| 配置 | 说明 |
| --- | --- |
| `BENCHMARK_GITHUB_TOKEN` | Release/Check API 写权限 |
| `OPENAI_API_KEY` | 模型 API key |

GitHub token 最小权限：

- Repository：仅 `QwenLM/qwen-code`
- Contents：read/write，用于读取和更新 Release
- Checks：write，用于创建 Check Run

正式环境优先使用 GitHub App installation token，不长期使用个人 PAT。

## 11. GitHub Release 派发

正式 workflow 建议：

```text
release.published
  -> 仅 stable Release 自动执行
  -> 通过 GitHub API 解析 tag commit
  -> self-hosted runner 调用 qwen-benchmark-dispatch
  -> submit CLI 写入 SQLite 后 Actions job 结束
```

dispatcher 请求必须包含：

- repository
- qwen_ref
- 40 字符 qwen_commit
- suite
- release_id
- GitHub run ID/attempt
- trigger 类型

示例：

```bash
sudo -n /usr/local/sbin/qwen-benchmark-dispatch \
  --repository QwenLM/qwen-code \
  --qwen-ref v0.20.0 \
  --qwen-commit 0123456789abcdef0123456789abcdef01234567 \
  --suite swebench_verified_harbor_smoke \
  --release-id 123456789 \
  --trigger release \
  --github-run-id 1234567890 \
  --github-run-attempt 1
```

## 12. 运行与排障

服务状态：

```bash
systemctl status qwen-benchmark-worker.service
```

日志：

```bash
journalctl -u qwen-benchmark-worker.service -f
```

检查 worker 进程和最近状态：

```bash
systemctl is-active qwen-benchmark-worker.service
journalctl -u qwen-benchmark-worker.service --since '10 minutes ago'
```

单个 run 的主要证据：

```text
<artifact_root>/<run_id>/
  request.json
  manifest.json
  status.json
  summary.json
  checksums.sha256
  grader/
  harbor/
  publisher-error.json   # 仅发布失败时出现
```

Harbor 原始任务目录：

```text
<harbor_jobs_root>/<run_id>/attempt-XX/<instance_id>/
```

判断任务是否真正成功时，应同时检查数据库终态、manifest 数量、`summary.json`、grader/verifier 结果和 checksum，不能只看 GitHub Actions dispatch job 为 success。

## 13. 安全边界

禁止提交：

- `benchmark.secret.env`
- `OPENAI_API_KEY`
- GitHub token/PAT
- SQLite 数据库
- raw trajectory
- Harbor job 原始日志
- 内网 endpoint 和未脱敏环境变量

建议公开：

- 聚合分数
- expected/completed/resolved/unresolved/infra error 数量
- Qwen Code 版本和 commit
- dataset/revision/suite
- run ID 和评测方法

当前方案没有 FastAPI、HTTP listener 或公网入口，不需要开放 8000/443。若未来改为远程控制面，再单独设计 HTTPS/OIDC API。

## 14. 已验证 POC

2026-07-22 使用以下配置完成端到端验证：

- Qwen Code：`0.20.0-nightly.20260722.b98306b7e`
- Commit：`77115af615fca031a57505dee07deeaf702a0937`
- Dataset：`swe-bench/swe-bench-verified@2`
- Suite：`swebench_verified_harbor_smoke`
- Case：`sympy__sympy-20590`
- Model：`qwen3.7-plus`
- 执行：1/1 completed
- 结果：1 resolved、0 unresolved、0 infra error
- Verifier reward：1.0
- 耗时：约 6 分 27 秒
- 测试：12 passed

该结果仅证明单 case POC 链路和执行器可用，不能代表完整 SWE-bench Verified 分数。

## 15. 当前限制与下一步

- 当前 worker 和 Harbor case 执行均为串行。
- SQLite 适合单机 POC，不适合多节点高写并发。
- publisher 当前为 best-effort，API 失败会记录 `publisher-error.json`，尚无持久化 outbox。
- 多 case run 的系统失败阈值尚未确定。
- 镜像依赖节点 Docker cache，正式环境应使用 ACR 复制或预拉取。
- 完整 SWE-bench Verified 运行前需实测资源、并发、超时和预算。

生产化建议依次完成：

1. GitHub App 凭证和 publisher outbox。
2. suite manifest 冻结及结果 schema 版本化。
3. 数据集 shard 和全局并发调度。
4. 多 worker/Kubernetes 资源池。
5. 私有 OSS 原始产物与公共聚合结果分层。
6. 完整版本历史汇总页面。
