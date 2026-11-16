# 无发布凭据的发布分流任务迁至 ECS

[English](2026-10-25-release-fanout-lane1.md) | [简体中文](2026-10-25-release-fanout-lane1.zh-CN.md)

## 问题与范围

[#15465](https://github.com/QwenLM/qwen-code/issues/15465) 记录了发布元数据任务等待 GitHub-hosted 容量 37–42 分钟的情况。本次只实现该 issue 的 Lane 1，遵循[发布任务迁离 Hosted 池](2026-10-16-release-jobs-off-hosted-pool.zh-CN.md)的凭据边界，不完成整个 issue，也不启用 Lane 2。

逐个核查的 job 均没有 `secrets` 引用或部署 environment。其 token 权限为 `contents: read`；这里“无凭据”指不含发布、签名、模型 API 或 OSS 凭据，并非没有临时 GitHub token。

| 工作流 / job                   | 入口                                                  | 工具与工作                                                        |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- |
| Desktop / `prepare`            | 已发布 release、dispatch、Desktop Checks 的可复用调用 | Bash、Git、gh、jq、curl；解析版本/ref，读取公开发布索引           |
| Live Host / `prepare`          | dispatch、pull request                                | Bash 内建；校验版本并输出元数据                                   |
| DSW benchmark / `release_gate` | 已发布 release、dispatch                              | Bash 内建；选择 benchmark 输入                                    |
| Managed runtime / `prepare`    | 已发布 release、dispatch                              | Bash、gh、jq、Git、Node；校验 release、读取包版本，不执行仓库代码 |

## 路由与信任边界

复用 `repo-hygiene.yml` 的仓库检查与 `MAINTAINER_ECS_RUNNER_DISABLED != 'true'` 条件，在官方仓库选择 `[self-hosted, linux, x64, ecs-qwen]`；其他仓库或禁用时回退 `[ubuntu-latest]`。变量未设置时立即选共享池，这纠正了原 issue 中“两个开关未设置则所有 job 不变”的矛盾验收描述。此 PR 不修改变量或 runner 标签。

Live Host 还接受 `pull_request`，因此其 ECS 条件额外要求 `github.event_name != 'pull_request'`，所有 PR（包括维护者 PR）仍走 hosted，不引入作者白名单。其他三个工作流没有 PR 事件；Desktop 现有的可复用调用方仅有 schedule/dispatch。测试固定这些入口。现有 trigger、step、permission、timeout、output 和下游依赖定义不变。

Lane 2 仍需运维提供隔离的发布主机并启用 `ECS_RELEASE_HOST_RUNNER_ENABLED`。Managed runtime 的 `release` job 含 OSS/签名凭据，保留 hosted。VS Code Companion 的 `prepare` 引用了 `OPENAI_*` secrets，尽管原 issue 将它列为 Lane 1，本次仍将其排除。发布、OSS 同步、平台构建、失败报告和其他所有 job 保持原路由。

## 工具与持久工作区

现有共享池 `repo-hygiene` job 直接调用 gh；SDK Java 的共享池 job 使用预装 Node，避免经过 ECS 出口代理下载。Git、Bash、jq、curl 也已被现有共享池工作流使用。这些元数据 job 不安装依赖、不构建产物；Managed runtime 仅使用 Node 内建文件系统/JSON 功能，无需新增 Node setup 或工具安装器。下游 job 现有 setup action 保持不变。这是源码级先决条件核查，不是对每台 runner 镜像的新探测。

Live Host 与 DSW 不读取 checkout。Desktop 与 Managed runtime 保留 `actions/checkout` 默认 `clean: true`（`git clean -ffdx` 加 reset）；其内联步骤仅检查元数据，不执行检出的 release 内脚本。没有依赖安装、构建产物写入或产物目录合并。完整发布构建的磁盘下限门在这里会增加开销，而非保护正确性边界，因此此有限改动不复制其 wipe/disk-floor 机制。如果这些 job 日后新增安装或重步骤，必须按 #15465 补 `restore_release_workspace` wipe anchor 与 disk-floor gate。Checkout 清理失败仍会使任务失败；runner/工具故障可以通过既有 kill-switch 回退 hosted。共享主机的隔离性仍低于专用发布主机，这正是不迁移发布凭据的原因。

## 验证与验收

扩展既有 runner 表达式求值测试，覆盖四个 job：官方 release/dispatch 使用 ECS；kill-switch 与非官方仓库使用 hosted；维护者与外部 Live Host PR 均留 hosted。固定无部署 secret/environment、只读 contents 权限，并约束无 PR 守卫的工作流不得新增 PR trigger。新增路由用例在旧的 hosted-only 定义上失败。

运行引用变更工作流的全部六个既有 script meta-test suite、runner-routing suite、格式、lint 和 diff 检查。两轮源码自审检查完整 diff，并确认其他 job 不变。没有产品/UI 行为变化，因此交互式 UI 验证不适用。此改动不触发工作流或生产发布。

验收依据为经过测试的路由与凭据边界。实际排队时间和可用性仍取决于 ECS 容量，需要在后续获授权的运行中观察；本 PR 不声称已经测得发布提速。
