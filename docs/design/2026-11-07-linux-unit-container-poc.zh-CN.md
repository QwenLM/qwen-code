# Linux 单测容器化 PoC

[English](2026-11-07-linux-unit-container-poc.md) | [简体中文](2026-11-07-linux-unit-container-poc.zh-CN.md)

## 问题与现状

外部贡献者 PR 目前使用 GitHub-hosted Linux runner 执行单测构建树与 8 个分片。ECS 池有空余容量，但不能让未知 fork 通过常驻自托管 runner 获得宿主机文件系统或凭据访问权，因此出现容量与隔离的矛盾。

本改动只做最小手动验证：在 ECS 的一次性 Docker 容器中，对独立选定的公开 SHA 完成构建和全量单测，不改变外部 PR 的默认路由。

## 改变方案的运行时发现

最初方案将现有构建及分片 job 放入 GitHub Actions job `container:`。运行 [`42340903564`](https://github.com/QwenLM/qwen-code/actions/runs/42340903564) 初始化了容器并检出 `2SinceJuly/qwen-code@2905dccbe45ed2917b28c7de6a935d031546ee43`，但 runner 的 `Starting job container` 日志包含：

```text
-v "/var/run/docker.sock":"/var/run/docker.sock"
```

该 runner 版本还自动挂载 `/__w`、`/__e` 和 runner-temp 等目录，即使 YAML 没有声明 socket 挂载。此类容器中的代码能够控制 Docker daemon，进而控制宿主机，故 job `container:` 在这里不能作为不可信代码边界。

那次尝试在隔离探针处停止，**没有执行依赖安装、构建或单测**。其 checkout 清理及 runner 驱动的容器删除均成功。普通 `test_build`、`test`、`lint_and_static` 已恢复为 PoC 前的原状。

后续 [`42354027932`](https://github.com/QwenLM/qwen-code/actions/runs/42354027932) 已移除 socket，但从阿里云 metadata `100.100.100.200` 得到 `HTTP 200`，因而在依赖安装前拒绝执行源码脚本，构建和单测同样未开始。这证明 UID/capability 限制本身不足以隔离云凭据。

在仅本次 PoC 的授权下，驱动创建专用 Docker bridge，并在宿主 `DOCKER-USER` 链上为该 bridge 对 `169.254.169.254` 和 `100.100.100.200` 加入 `REJECT`。同一个 `EXIT` trap 删除容器、bridge 和对应规则，并复核规则与网络均不存在。缺少 sudo 或链支持时前置失败，不从源码处回到更弱边界。

## 范围

范围内：

- 可信现有 `workflow_dispatch` 入口上的显式 `linux_unit_container` 开关。
- 以公开 `owner/repository` 与小写完整 40 位提交 SHA 指定被测源码。
- 新增一个不带 `container:` 声明、仅 `contents: read` 的 `linux_unit_poc` job。
- 使用固定版本的 actions checkout，在独立目录检出，`persist-credentials: false`，并精确核对本地 `HEAD`。
- 由可信 workflow 内联的驱动显式创建一次性 Docker 容器，而不是请求 runner 分配 job container。
- 在同一个容器内完成一次构建及完整 `run-unit-test-lanes.sh`，避免不可信构建归档跨容器传播。
- 用元测试固定按需行为、既有 job 不变、源码校验、隔离检查及清理语义。

范围外：

- 在 `pull_request`、`push`、`merge_group` 或定时执行中自动使用该模式。
- 改变外部 PR 默认路由或 opt-in 执行之外的既有 8 分片路径。
- 使用 `pull_request_target`、privileged 容器、宿主网络、Docker socket 或共享凭据/缓存挂载。
- 一次性 runner 自动扩缩容、正式准入服务，或宣称 Docker 可以证明对所有内核逃逸和拒绝服务安全。
- 生产分片。首轮闭环刻意保留单一容器，避免把产物来源与信任链误判为无害传输。

## 执行模型

dispatch 版本在被测 checkout 存在前确定 workflow 定义。被测仓库与 SHA 仅为数据输入，不能改写该定义及其隔离探针。

当 `linux_unit_container=true` 时：

1. 可信分类器为普通全量 CI 负载选择 `docs_only`，避免其他既有 job 执行相应测试主体。
2. `linux_unit_poc` 校验仓库格式与完整 SHA，在唯一 run/attempt 子目录检出，禁用凭据持久化，并验证实际提交及本地 GitHub 认证 header 不存在。
3. 可信内联 Dockerfile 在 `node:22-bookworm` 上安装 tmux/zip/util-linux 工具，不读取被测 checkout 的上下文或指令。
4. 驱动执行 `docker create`，使用 `--init`、`--user node`、`--cap-drop ALL`、`--security-opt=no-new-privileges`，且仅将指定源码目录只读挂载。禁用 privileged、宿主网络、Docker socket、基 workspace 挂载及携带 secret 的环境。
5. 执行源码脚本前，容器检查 `NoNewPrivs=1`、有效 capability 不含 `SYS_ADMIN`、`SYS_PTRACE`、`NET_ADMIN`、`DAC_OVERRIDE`，无 Docker socket，Node 为 22，AWS/阿里云 metadata 不可达或被明确拒绝。
6. 将 `/source:ro` 复制到 `/tmp/repository`，以 UID 1000、全新 HOME/Corepack 缓存及清空的模型凭据，安装锁定依赖，运行 `npm run build`、`npm run bundle` 和完整测试脚本。只有预期 SHA 被显式传入测试容器。
7. `EXIT` trap 强制删除容器及其卷，`docker ps --all` 复核容器已不存在，最后以受保护的步骤删除专用 checkout。

探针、驱动、Dockerfile 与清理逻辑都内嵌在可信 dispatch workflow 中，被测仓库不能用自己的安全实现替换它们。

## 安全边界与已知局限

本 PoC 验证具体隔离机制，不无条件声称 Docker 对所有恶意输入都是沙箱。

- ECS 宿主内核共享，容器逃逸、内核漏洞及恶意资源消耗仍可能发生。job timeout 之外的资源上限需要生产决策。
- metadata 只覆盖 `169.254.169.254` 和 `100.100.100.200`，其他内网出向未获证明。
- 镜像沿用本仓容器任务已有的可变 `node:22-bookworm` 标签。生产边界必须固定可信 digest 并审查供应链。
- 本 PoC 不对专用 checkout 之外的 runner 残留做消毒，不为其他 runner 挂载、凭据或同驻任务背书。
- 正常收尾、探针失败与测试失败都会删除容器与 checkout。强制取消 job 或宿主故障可能留下残留，需要 watchdog。
- 本方案消除跨容器构建归档，但尚未给出具有同等来源保证的生产分片设计。
- opt-in profile 在手动运行时有意抑制无关全量 CI 主体。只有新增 job 成功才是证据；跳过测试的聚合 job 变绿不是证据。

生产化仍需 PR 独立的可信准入路径、不可信代码专用执行池、有界出向、每 job 资源限制、watchdog 清理，以及最好每 job 一个、保证干净环境的临时 runner。GitHub 官方推荐 Just-in-Time runner 配合自动化干净环境保证，单纯复用硬件不足。

## 文件

- `.github/workflows/ci.yml`：按需模式、源码校验、显式容器驱动、隔离探针及清理。
- `.github/scripts/ci-runner-routing.test.mjs`：范围、输入、隔离与既有路由不变的回归覆盖。
- `docs/design/2026-11-07-linux-unit-container-poc.md` 与 `.zh-CN.md`：设计、实测约束与局限。
- `.qwen/e2e-tests/linux-unit-container-poc.md`：验证计划及结果，不作为跟踪交付物。

## 验证与验收

静态检查须证明普通事件保持既有路径、新增 job 只在手动 opt-in 运行、没有任何 job `container:`，且原始容器创建不开放 Docker socket 或提权通道。PoC dispatch 为 workflow 并发组追加 `-linux-unit-poc`，允许在旧实验收尾时直接开始修订版验证；普通 PR 与 dispatch 分组不变。

真实 dispatch 必须将 workflow head 与独立公开源码 SHA 锚定到同一 run，并证明：

- 源码校验及隔离探针全部通过；
- 在显式容器内以 UID 1000 完成依赖安装、构建与全量测试；
- opt-in 之外的既有 8 分片路径完全未变；
- 容器及其卷删除、专用源码 checkout 删除均有实际证据；
- 剩余网络、运行及安全警告完整保留在结果中。
- 非法仓库、分支名、短 SHA 和凭据持久化均被拒绝。

只要 metadata 开放、socket 存在、任一测试命令失败或清理没有证据，就不得报告绿色闭环。未评审剩余威胁及生产架构前，本 PoC 不能作为自动切换外部 PR 路由的授权依据。
