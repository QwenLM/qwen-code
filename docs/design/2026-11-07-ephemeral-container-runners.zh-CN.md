# 外部 PR 的一次性容器 runner

[English](2026-11-07-ephemeral-container-runners.md) | [简体中文](2026-11-07-ephemeral-container-runners.zh-CN.md)

日期：2026-11-07。状态：已实现并在 hz4 部署五槽位 systemd 试运行服务；
外部 PR 的生产路由仍未启用。

杭州共享测试机上已验证 10 个槽位同时注册，并执行同一个私有测试仓库的 10 个无密钥
测试 job，容器、网络和注册均已回收。后续单槽位试运行使用真实 PAT，
通过两个串行 GitHub Actions job 验证注册、容器替换、工作区隔离及 job 内
没有 PAT；强制结束 manager 后也验证了 systemd 重启及补位前清理。
试运行发现并修复了 gh 2.46 分页兼容性及 Docker quiet 模式覆盖格式化
槽位输出的问题。完整 PR CI 和生产隔离仍未验证，共享主机只用于受控试验。

后续模型访问见 [runner 与模型代理结合方案](2026-11-07-ephemeral-runner-model-proxy.zh-CN.md)；
该方案尚未实现或启用。

## 目标和边界

将整个 GitHub Actions runner 放进一次性 Docker 容器。容器执行一个 job，
随后删除；下一次从同一个干净镜像创建新容器、新 runner 身份和新工作目录。
用户不希望为 CI 中的每条命令维护权限白名单。

一次性单位是 job，不是 workflow、step 或 PR。多个 job 通过 GitHub artifacts
交换文件，不共享可写工作目录。

本设计解决运行环境残留和跨任务文件、进程污染。普通 Docker 共享宿主机内核，
不提供虚拟机级恶意代码隔离；传入 job 的任何密钥仍可能被该 job 读取。
首期只接无长期密钥的 Linux CI，不建设模型网关，不迁移发布、自动修复、
真实模型 E2E 或需要 Docker daemon 的任务。

## 架构

```text
外部 CI 专用 ECS
├── systemd 托管的管理程序（长期运行，可信）
│   ├── 使用宿主机 PAT 申请 JIT runner 配置
│   ├── 启动、监控、删除容器及其独立网络
│   └── 保存管理状态、导出日志、恢复异常任务
├── 槽位 1：容器 A → 一个 job → 删除 → 容器 C
└── 槽位 2：容器 B → 一个 job → 删除 → 容器 D

每个容器
├── 一个 JIT runner，主动连接 GitHub
├── Node.js 22、Git 和 CI 依赖
└── 独立的 HOME、工作目录、临时目录、npm 缓存
```

管理程序按配置维护固定数量的槽位，每个槽位最多一个容器；杭州十槽位试验同时使用
十个槽位，hz4 部署目前维持五个槽位。不接 webhook、不自行调度 PR、不引入 Kubernetes 或数据库。
GitHub 根据 runner 标签分配任务。每台 ECS 各运行一个管理程序，只连接本机
Docker socket，使用独立的 `poolId` 和按主机配置的 `slots`。各主机共用调度
标签，无需中央管理器。新名称使用 `ecs-qwen-` 前缀以兼容 CI 并发上限和超时；
恢复时仍接受旧的 `qwen-` 身份。

启用 systemd 服务后开机启动，意外退出时十秒后重启（`Restart=always`）；
显式停止服务后保持停止。它监督进程退出，不检测进程存活但卡住的情况。

镜像由可信构建生成并固定 digest。管理程序和镜像只能从经过维护者控制的版本
部署，不从任务 checkout 或 PR artifacts 更新。

认证使用专用 PAT，以 `GH_TOKEN` 写入仅 root 可读的 systemd EnvironmentFile：
`/etc/qwen-ephemeral-runner/credentials.env`。fine-grained token 应只选择目标
仓库及 GitHub API 要求的 Administration: write；它不只限于 runner 操作。
外部协作者身份或组织策略可能使 fine-grained token 不可用，改用权限更宽的
classic token 必须明确决定。PAT 留在宿主机，不进入配置 JSON 或任务容器。
宿主机 root 和 Docker 管理员仍属于可信边界。到期前替换凭证文件并重启服务；
仓库级 runner 不需要 GitHub App 或组织级 runner 管理权限。

## 所有权和生命周期

| 对象                         | 所有者       | 生命周期                            |
| ---------------------------- | ------------ | ----------------------------------- |
| ECS、Docker daemon、管理程序 | 运维/维护者  | 长期                                |
| 宿主机 runner 管理 PAT       | 管理程序     | 不进入任务容器                      |
| 干净镜像                     | 可信镜像构建 | 版本化、不可由 job 回写             |
| JIT 配置、runner 身份        | 单个容器实例 | 只用于一个 job                      |
| 容器可写层和任务数据         | 单个容器实例 | 销毁时删除                          |
| Docker bridge 网络           | 单个容器实例 | 销毁时删除                          |
| 诊断日志                     | 管理程序导出 | 有大小和保留期限，不被后续 job 读取 |

正常路径：申请 JIT → 创建独立网络和容器 → runner 上线 → 执行一个 job →
runner 退出 → 导出日志 → 删除容器与网络 → 清理残留注册 → 创建下一份。

JIT 提供正常协议下的单任务注册语义；宿主机管理程序负责实际销毁。
不能依赖恶意任务自行退出、完成最后一个 cleanup step 或保持 runner 完整。
容器外 watchdog 强制限制最长存活时间，管理程序重启时先对账旧资源。

容器删除失败时停止对应槽位；GitHub 注册清理失败时记录并重试，不继续无限
申请新身份。宿主机故障期间无法即时清理，恢复后必须先回收再接新任务。

## 最少但必要的部署边界

- 使用外部 CI 专用 ECS；不与持有长期密钥的现有 runner 共用主机。
- 不挂载宿主机 home、工作区、管理状态、凭证目录、Docker socket；不使用
  privileged、host PID 或 host network。容器内无需逐命令白名单。
- 镜像不声明持久 VOLUME，首期不创建任务卷；全部任务写入容器可写层。
- 宿主机外/容器无法修改的网络策略阻止访问管理接口、敏感内网、实例凭证和
  元数据；配置实际需要的 GitHub、npm、镜像服务出口。
- 旧可信 runner 的访问权必须在 GitHub 侧检查。标签和 PR 可修改的 YAML 都
  不是授权边界；外部 PR 不得通过修改 runs-on 绕回敏感池。
- 不因启用自托管 runner 而开放 fork secrets，也不引入执行 PR 代码的
  pull_request_target 特权流程。

## 首期路由决策

保留现有 `ubuntu_runner` 输出及其所有旧语义，新增 `pr_test_runner` 输出，
用于 `test_build` 和 `test`。对于非可信作者的外部 fork PR，变量
`EXTERNAL_PR_EPHEMERAL_RUNNER_ENABLED=true` 选择一次性池；未设置、`false`
或其他值选择 `ubuntu-latest`。`lint_runner` 在 `lint_and_static` 和
`integration_no_ak` 中遵循同一个开关，替代这些 fork 任务原有的共享 ECS
回退行为。可信作者和同仓库 PR 路由不变。全局 kill-switch 和 hosted 设置优先。

开关在 job 求值时选择目标，不查询 runner 是否空闲，也不能迁移已排队任务；
回滚时取消已排队任务并启动新的 workflow run。上线前用实际 shell 选择器
验证未设置/false/非法值、开启时的两种架构，以及全局覆盖开关。

`classify_pr`、`web_shell_e2e_smoke`、`integration_cli`、其他 workflow
保持当前路由。这样不把新镜像尚未验证的浏览器系统依赖一起迁入，也不改变
现有分类 job 与其他 workflow 的路由镜像关系。

新池标签为 `ecs-qwen-ephemeral`。默认路由使用 x64，设置变量
`EXTERNAL_PR_EPHEMERAL_ARCH=arm64` 可改用 ARM64；完整 PR CI 在新镜像上的
工具链仍须验证。

## 依据

- [GitHub ephemeral runner 语义与清理责任](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#ephemeral-runners-for-autoscaling)
- [GitHub 仓库级 JIT API](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository)
- [Docker 的 daemon 与内核安全边界](https://docs.docker.com/engine/security/)

本设计采用的事实已在本次讨论中核对官方文档；部署时再次确认实际 runner
版本、GitHub 账户能力、API 权限和 ECS 网络配置。
