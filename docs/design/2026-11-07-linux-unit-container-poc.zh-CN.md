# Linux 单测容器化 PoC

[English](2026-11-07-linux-unit-container-poc.md) | [简体中文](2026-11-07-linux-unit-container-poc.zh-CN.md)

## 问题与现状

外部贡献者 PR 目前使用 GitHub-hosted Linux runner 执行单测构建树及 8 个测试分片。现有 ECS 池有空余容量，但常驻自托管 runner 不能直接运行未隔离的未知 fork 代码。可信输入的 Linux 单测已经能在 ECS 上通过，托管排队却会拖慢外部 PR 的整条 CI 链路。

本改动目标是完成一个最小、可实际运行的容器化验证，不是自动切换外部 PR 的默认路由。

## 范围

范围内：

- 在现有 `.github/workflows/ci.yml` 的 `workflow_dispatch` 入口增加显式开启的 Linux 单测容器模式。
- 允许该手动运行独立于 workflow 版本选择公开源码仓库及精确的 40 位提交 SHA。
- 仅在选中该模式时，让 `test_build` 和全部 `test` 分片进入 `node:22-bookworm`。
- 复用既有 checkout、依赖安装、构建缓存归档、artifact 传递和 `run-unit-test-lanes.sh` 测试路径。
- 增加由可信 workflow 直接提供的源码校验、容器隔离探针和 PoC 清理步骤。
- 在现有 runner 路由元测试中增加回归覆盖。

范围外：

- 在 `pull_request`、`push`、`merge_group` 或定时运行中开启容器模式。
- 改变外部贡献者 PR 当前的默认 runner 策略。
- 建设一次性自托管 runner 自动扩缩容系统。
- 宣称 GitHub Actions job container 单独构成完整的恶意代码安全边界。
- 使用 privileged 容器、Docker socket、宿主网络，或通过 `pull_request_target` 检出不可信代码。

## 执行模型

workflow 定义与容器配置由可信的手动 dispatch 版本在检出源码前确定。被测仓库与提交只是输入数据，不提供本次 dispatch 的 workflow 定义。

当 `linux_unit_container=false`（默认值）时，两个 job 继续产生既有的 `null` 容器值，执行路径保持不变。当其为 `true` 时：

1. 校验源码仓库为 GitHub `owner/repository` 形式，且 `branch_ref` 为完整提交 SHA。
2. 给 `test_build` 和全部 8 个 `test` 分片选择带 init 与 `no-new-privileges` 的 `node:22-bookworm`。
3. 以不持久化 checkout 凭据的方式检出指定源码，并精确核对最终 `HEAD`。
4. 证明步骤确实在容器内，检查本 PoC 限定的性质：不存在 Docker socket，有效 capability 不含 `SYS_ADMIN`、`SYS_PTRACE`、`NET_ADMIN`，`NoNewPrivs=1`，AWS 与阿里云 metadata 端点不可达或被明确拒绝。
5. 不改构建树归档和全部 8 个单测分片的执行路径。
6. 在所有结果上传后删除 checkout 内容；runner 的容器拆除日志作为实际验证中的最终容器清理证据。

源码校验、隔离探针和清理直接内嵌于可信 workflow，不从被测 checkout 加载，避免被测代码削弱自身检查。

## 安全边界与已知局限

本 PoC 只验证有限的隔离性质，不引入 `pull_request_target` 或其他特权事件。手动运行使用公开源码并禁止 checkout 凭据持久化，不新增仓库 secret。

下列事项仍是生产化问题，不属于本 PoC 声称已经成立的性质：

- runner 自身状态，以及被清理 checkout 之外、由 runner 管理的 bind mount。
- 未知容器逃逸、内核漏洞，以及常规 job 限制之外的拒绝服务。
- metadata 探针之外的内网出向访问。
- 不可信构建归档跨容器传递的风险。
- 强制取消 job 或 runner 丢失后的清理。
- 外部 PR 能够修改自身 `pull_request` workflow YAML 时，如何强制执行容器配置。

生产化仍需 PR 独立的可信准入路径、不可信代码专用执行池、出向访问限制，以及最好每 job 一个、具有干净执行环境的临时 runner。GitHub 官方建议使用 Just-in-Time runner，并以自动化保证干净环境；仅复用硬件而没有这一保证并不够。

## 文件

- `.github/workflows/ci.yml`：按需模式、源码输入、容器选择、校验/探针与清理。
- `.github/scripts/ci-runner-routing.test.mjs`：按需行为与不变量回归。
- `docs/design/2026-11-07-linux-unit-container-poc.md` 与 `.zh-CN.md`：设计及验证边界。
- `.qwen/e2e-tests/linux-unit-container-poc.md`：验证计划与观察结果，不作为跟踪交付物。

## 验证与验收

静态检查须证明普通事件没有容器，PoC 仅限手动 dispatch，两个执行 job 使用同一份可信配置，外部 PR 路由不变。

真实 dispatch 必须使用精确的公开源码 SHA，并证明：

- 全部隔离探针通过；
- 构建树构建一次并由 8 个分片共同消费；
- 全部单测分片成功；
- PoC 清理步骤完成后 workspace 为空；
- runner 日志显示容器拆除；
- 报告绑定实际 run URL，记录耗时和剩余警告。

除非后续设计关闭或明确接受所有残余安全限制，否则本 PoC 不能充当自动切换外部 PR 路由的证据。
