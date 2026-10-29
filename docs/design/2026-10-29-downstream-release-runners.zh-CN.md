# 下游发布 runner

[English](./2026-10-29-downstream-release-runners.md)

## 问题

CLI 发布后会并行触发 VSCode、SDK、Desktop、Managed Runtime、OSS、Chrome
和收尾任务，每个阶段都可能重新排 hosted 队列。主流程优化不能消除这些等待。

## 设计

复用 ECS_RELEASE_HOST_RUNNER_ENABLED 和 ecs-qwen-release-host。开关未设置时
保持 hosted。不按 workflow 建池，也不通过全局 concurrency 串行独立发布：
GitHub 会替换该组更早的 pending run。少量 release runner 槽位可以正常排队，容量按实际
等待及执行时间调整；一个 runner 槽位不会让下游依赖关系变成串行。

承载 release 专用 label 的 runner 是 ARM64，因此所有 release 专用 label 都
不含架构组件。带 "x64" 不会回退到 hosted，而是永远匹配不上，任务一直排队到
超时。只有确实与架构无关的任务才迁到这里。

checkout 前，使用任务 token 从固定 workflow revision 下载预检脚本到工作区外。
这段逻辑由一个 composite action 统一承载，以 `$/.github/actions/...` 引用，
从而在当前 commit 解析：用 `./` 需要先 checkout，而在持久机器上还会执行上一个
任务残留在磁盘上的 action 目录。预检会规范化并清空工作区，拒绝经由符号链接
组件解析或落在 runner 工作区之外的路径，然后在 runner temp 隔离 Git、npm、
gh 和 Docker 状态，并断言 Node 22。迁移的任务使用预装 Node 22 和任务
私有的 npm 安装目录。

在现有共享 ECS 主机上预留带 release label 的 runner 进程，先使用 hz1-17 和
hz1-18。移除它们的普通 `ecs-qwen` 标签，同机其他 runner 和其他机器继续使用。
这只预留调度槽位，不独占整台机器。label 和预检清理不能阻止同机 PR 进程访问
主机或发布凭据；选定的共享主机部署接受这一限制，不声称具备机器级隔离。

迁移 VSCode prepare/publish 和 universal 构建腿、finalize、Desktop 发布、
Chrome 构建和发布、GHCR 构建，以及音频预构建汇总任务。已迁移的只读 prepare
保持现状。macOS/Windows 及 Desktop Ubuntu 22.04 原生构建保留现有 runner，
维持签名、工具链和 glibc 兼容。VSCode 的路由按 `matrix.universal` 判断而不是
`matrix.os`：universal 腿用 `--omit=optional` 打包，不含原生 node-pty；而
原生 linux-x64 腿按构建主机解析原生依赖，保留 hosted。

三个 OSS 同步和 Managed Runtime 发布**不**迁移。它们下载并执行硬编码的
linux-amd64 ossutil，即使 label 匹配，在 ARM64 上也会 exec format 失败。
按 `runner.arch` 选择该二进制及其校验和是独立改动，需要独立验证。

SDK 增加可选 ECS producer，保留 hosted publisher。用 YAML anchor 共用构建
步骤和单任务 hosted 回退路径，禁用 ECS 时不增加 hosted 排队。固定 producer
源码 SHA，在同一次运行的 artifact 中交接包含版本化 manifest 的最终 npm
tarball，通过 job outputs 返回版本信息。测试后重新复制所选 CLI 并写入元数据，
禁止打包生命周期脚本。hosted 禁用脚本并带 npm provenance 发布这个确切包。
重试时跳过已发布的相同字节，拒绝不同字节。dry-run 不写外部状态，构建失败由
独立任务上报。

npm trusted publishing 和 provenance 要求云托管 runner，所以最终 npm 发布留在
GitHub hosted 是契约要求，不是图省事。把 provenance publisher 挪到 self-hosted
不会加快发布，只会让发布失败。

手动触发的 Python/Java SDK 及混合 npm 发布的 Live Host publisher 不属于本次
CLI 发布下游迁移，保留平台及认证契约。

## 音频预构建复用

该机制在[音频预构建复用](./2026-10-29-audio-prebuild-reuse.zh-CN.md)中单独
描述，本改动基于它。该机制不依赖 ECS_RELEASE_HOST_RUNNER_ENABLED，开关未
设置时即可生效；这里的ECS 构建任务在已选中复用产物时消费同一份产物。

## 验证与上线

更新 workflow 契约测试，增加预检和 tarball fixture，运行 workflow lint、
定向测试、build、typecheck、bundle，审查完整 diff。本地修改不执行真实发布、
修改 runner 或启用开关。

启用开关需要按顺序满足：带 release label 的 runner 进程不再与 PR 任务共享池，
构建与发布拆分已进入 main；这些任务依赖的工具齐备（Node 22、corepack/pnpm、
gh、GNU realpath、unzip、zip、jq，以及镜像构建需要的 Docker）；以及一次真实
Actions dry-run。Desktop 原生迁移先需要兼容镜像。音频复用不需要这些前提。

## 涉及文件

.github/workflows 发布流程、.github/actions 下的共用预检 action、
.github/scripts 共用脚本、scripts/tests 的 workflow 测试及 workflow 大小基线。

## 待确认

预留 runner 容量和实际 dry-run 结果由上线验收确认；已启用的 ECS 任务失败后不自动切回
hosted。把 OSS 同步和 Managed Runtime 发布改成架构自适应被推迟，在那之前这部分
下游仍然要付 hosted 排队成本。
