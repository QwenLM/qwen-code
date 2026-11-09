# 外部 PR 的一次性容器 runner

[English](2026-11-07-ephemeral-container-runners.md) | [简体中文](2026-11-07-ephemeral-container-runners.zh-CN.md)

日期：2026-11-07。状态：runner 生命周期已实现，hz4 已部署十个固定槽位。
外部 PR 直接路由仍需部署默认分支，并完成真实 CI 验收。

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
十个槽位，hz4 部署目前维持十个槽位。不接 webhook、不自行调度 PR、不引入 Kubernetes 或数据库。
GitHub 根据 runner 标签分配任务。每台 ECS 各运行一个管理程序，只连接本机
Docker socket，使用独立的 `poolId` 和按主机配置的 `slots`。各主机共用调度
标签，无需中央管理器。显示名称使用 `ecs-qwen-<poolId>-<slot>-<suffix>`，槽位
补齐两位并附八位十六进制后缀，例如 `ecs-qwen-hz4-ephemeral-01-1a2b3c4d`。
每次注册都换新后缀，因此仍占用旧名称的残留注册不会以 HTTP 422 拒绝新注册；
每个 job 的 GitHub runner ID、容器和内部 UUID 也都重新创建。状态和诊断文件名
保留 UUID。`ecs-qwen-` 前缀兼容 CI 并发上限和超时；恢复时仍接受带后缀的名称、
之前带 UUID 的 runner 名称，以及旧的 `qwen-` 身份。

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

只有每次重试仍能触达待回收资源时，重试才是安全的。2026-11-08 在 hz4 实测到
两个自我永续的卡死，现已修复。其一，命令超时杀掉 `docker create` 客户端并不会
让 daemon 停止创建，容器可能在 cleanup 删除槽位状态之后才出现；cleanup 随后
拒绝处理无法确认身份的容器，而唯一能删除它的代码恰好在这道拒绝之后。现在改为
依据 `qwen.instance` 标签确认身份，标签必须匹配本池本槽位且无歧义，其余情况
仍然阻塞该槽位等待人工对账。同日稍晚的事故表明「单一身份」规则本身也会卡死：
Docker 卡死时会在同一槽位堆下多个身份不同、从未启动的容器，拒绝择一处理让
30 个槽位中的 15 个各卡了 960 次相同重试。由于每个槽位的周期是串行的，无状态
槽位里的所有遗留资源都是孤儿，因此多身份孤儿堆现在整体删除，随后按名字清扫该
槽位的注册。清扫要求每个遗留资源都带有本槽位的身份前缀，且只删除 GitHub 已
报告 offline 的注册——online 注册可能属于本主机视野之外的存活 runner；标签
缺失或属于外部时仍然阻塞该槽位。其二，JIT 请求被拒绝时删除了本地槽位状态，而残留
注册仍占用同一显示名，导致每次重试都被拒绝，且能删除该注册的记录已经丢失。
现在明确被拒绝时改为对账该名字而不是丢弃状态；GitHub 拒绝删除 runner 时保留
状态，交由下一次重试处理。

这类故障中进程始终存活，systemd 监管无法发现。某个槽位持续重复同一失败达到
`stallAlertSeconds`（默认 1800 秒，即 30 分钟）时，输出 `STALL ALERT`，包含
槽位、时长、次数和错误；任意一次成功或错误发生变化都会重置计时，每次停滞只告警一次。
门槛按墙钟时间计，因为失败周期采用带抖动的指数退避（10 秒到 60 秒，
HTTP 403/429 时 30 秒到 300 秒），重试次数不再对应固定时长。退避睡眠按秒
切片，收到停止信号即提前结束。这是槽位不再承接任务时的运维信号，
应据此告警，而不是依据服务状态。早先按重试次数计的 `stallAlertRetries`
已不再被读取；配置里若仍保留该键不会生效，将回落到默认值。

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

保留现有 `ubuntu_runner` 输出及其所有旧语义。非可信作者的外部 fork PR 中，
`pr_test_runner` 直接选择
`["self-hosted", "ecs-qwen-ephemeral"]`，用于 `test_build`
和 `test`。`lint_runner` 为 `lint_and_static` 和 `integration_no_ak` 选择
相同目标。可信作者和同仓库 PR 路由保持不变。

真实外部 PR run 42382582937 的第二次尝试中，仓库设置有值，运行收到的仓库
变量却为空。直接路由移除这个依赖，不需要配置中继或手动 smoke workflow。
十个已注册 runner 使用正式标签验收真实 CI。管理程序接受单宿主机最多 64 个槽位；
在成功率、耗时和资源占用稳定前保持保守容量，增加容量通过手动配置完成，不按队列自动扩缩容。

现有全局覆盖开关在能够读取其值的上下文中仍优先。fork 触发的运行不能依赖
这些变量回滚；应将 fork 选择器改为托管机器，部署 workflow 变更，再用该版本
触发全新 CI。按需取消已经选择执行目标的任务；重跑保存的旧 workflow 不会更新
路由，任务也不会自动迁移。使用实际 shell 选择器验证变量为空的 fork 场景、
可信和非 PR 事件的路由，以及可读取的全局覆盖开关。

`classify_pr`、`web_shell_e2e_smoke`、`integration_cli`、其他 workflow
保持当前路由。这样不把新镜像尚未验证的浏览器系统依赖一起迁入，也不改变
现有分类 job 与其他 workflow 的路由镜像关系。

2026-11-08 更新：无凭据的 Web-shell Visuals capture 任务迁入本池，
**仅限非可信 fork PR**——同仓 PR 留在托管泳道（即本任务迁移前所在
位置；上文「受信与同仓 PR 路由不变」的规则仍然有效）。主 CI 的
`Test (ubuntu-latest, Node 22.x)` 聚合门禁曾迁到这里、又迁了回去
（见下）。capture 任务与本池安全模型完全一致（不可信 PR 代码、只读 token、仅事件级
`GITHUB_TOKEN`），因此上面「不迁浏览器依赖」的排除对这一个任务不再适用：
它在 self-hosted 前置检查后复用镜像自带 Node，先过按本泳道标定的磁盘
水位门禁（剩余 ≥8 GiB 且已用 <85%——共享的 2 GiB 默认值曾放行一个
剩余 14.6 GB、已用 89% 的槽位，几分钟后 pnpm 即 ENOSPC），渲染钉住
`--workers=2`（不钉的话会按宿主核数在 4 CPU 容器里起 Chromium，实测把
runner 进程本身饿到失联），超时按路由取池上 90 分钟 / 托管 45 分钟
（实测两次冷装 22 分 18 秒、36 分 48 秒时 Chromium 仍在下载），并在
运行时尽力安装 DejaVu 字体基线和 ffmpeg——apt 出口与 Debian 归档仍是硬性前提
（前面的 `playwright install --with-deps` 步骤依赖同一归档）；best-effort 仅
覆盖这一步自身额外字体/ffmpeg 安装失败的情况，降级为回退字体和仅 .webm
录制，而不是让预览失败；apt 调用带时限，安装后校验字体基线。首次完整
池上渲染仍需验收字体度量与端到端耗时。同仓 PR 始终留在托管泳道，不存在回退；fork 触发的 run 收到的仓库
变量为空（见上文 fork 一节），开关回退不到它们，fork 路径的真正逃生
通道是改 `main` 上的 selector，而不是这个开关。E2E OpenTUI 泳道刻意留在托管：它注入长期模型
secrets，本池边界禁止，需等独立受信池。

2026-11-09 更新：聚合门禁不再使用本池。它是 `pull_request`/`push`/
`merge_group` 的必需检查，钉在手工扩缩的池上曾以空 runner 排队 110 分钟
（job 128729488158），而兄弟任务约 3 分钟即被接走——`timeout-minutes`
不覆盖排队时间，舰队级 kill-switch 又够不到 fork run。它现在与兄弟聚合
任务同形，直接跟随分类器的 `ubuntu_runner`：受信事件走持久舰队、不可信
fork 走托管，kill-switch 经分类器在所有路径上生效。

池标签为 `ecs-qwen-ephemeral`，首期部署注册了十个 ARM64 runner，
2026-11-08 实时查询显示 hz4 上有 22 个在线槽位注册。只注册
`self-hosted` 和这个专用标签，不注册通用 Linux、ARM64 标签，避免其他宽泛
ARM64 选择器将无关任务送入本池。完整 PR CI 在新镜像上仍需验证。
已记录的宿主机、网络和 runner 授权限制仍待解决，更换标签不会消除它们。

## 依据

- [GitHub ephemeral runner 语义与清理责任](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#ephemeral-runners-for-autoscaling)
- [GitHub 仓库级 JIT API](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository)
- [Docker 的 daemon 与内核安全边界](https://docs.docker.com/engine/security/)

本设计采用的事实已在本次讨论中核对官方文档；部署时再次确认实际 runner
版本、GitHub 账户能力、API 权限和 ECS 网络配置。
