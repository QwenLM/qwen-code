# 音频预构建复用

[English](./2026-10-29-audio-prebuild-reuse.md)

## 问题

每次发布都会为五个目标重新构建原生音频预构建产物，即使影响这些二进制的输入
没有任何变化。构建本身很短，等待不短。v0.26.3 的 Linux x64 预构建排队 74
分钟，执行只用 50 秒，随后汇总步骤又排了一次。由于 `publish` 依赖该汇总，
整个发布都卡在后面。

音频预构建适合复用，恰恰因为它调度代价高而校验代价低：五个原生 `.node`
文件，其输入可以由某个已知 commit 上的仓库内容完整描述。

## 设计

发布先对音频构建输入取指纹，再查找此前一次成功的官方 `main` 发布产出的、
指纹相同的产物，命中则复用而不是重新构建。

### 指纹覆盖什么

覆盖所有可能改变构建结果的内容身份（git blob OID）：
`packages/audio-capture`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、
`.pnpmfile.mjs`、`.npmrc`、根 `package.json` 的 `packageManager` pin，以及
生产该产物的 workflow 和这个辅助脚本本身的内容。把 workflow 纳入哈希，正是
Node 版本 pin 和 `prebuildify --target` 参数进入 key 的方式。

两处有意排除：`packages/audio-capture/package.json` 的 `version` 字段——版本
号是打包元数据，原生构建的任何环节都不读它；以及根 `package.json` 中除
`packageManager` 以外的全部内容。没有第一条排除，任何发布都无法复用另一次
发布的产物。

没有 `pnpm-lock.yaml` 的 ref 产出空 key，永不复用——较老的 ref 没有可比对的
原生依赖冻结图。

### 什么样的产物才可信

复用意味着执行由此前运行构建出的字节，所以来源要校验而不是假定。候选产物
必须以精确指纹命名、未过期、所属运行的 repository 与 head repository 都是
本仓库，且来自 `main` 上由 `workflow_dispatch` 或 `schedule` 触发的、
**已完成且成功**的 `release.yml` 运行。这排除了 fork PR、`workflow_run`
生产者，以及直接 dispatch 音频 workflow 的情形。

传输完整性已有保障：pin 住的 `download-artifact` 会比对产物摘要，不一致即
失败。

### 保留期：选择 vs 消费

选择时要求至少剩余 48 小时保留期，使选中的产物能活过发布的其余阶段。下游
消费方只要求产物尚未过期。

两者必须不同。按更晚的时钟重复套用选择期余量，会拒绝一个发布已经选定的
产物：剩 48 小时 1 分钟的产物在 `prepare` 通过，两分钟后失败——而此时还剩
47 小时 59 分钟，且 `prepare` 已经跳过原生构建矩阵，没有任何回退。

### 失败处理

指纹计算、查询、试下载与校验都是非致命的，而复用 ID 只在**试下载与载荷
校验**都成功后才发布：

- 查询 API 失败 → 没有候选
- 指纹计算或临时目录创建失败 → 没有 key，执行原生构建矩阵
- 下载失败 → 跳过接受步骤（以 `outcome` 为判据，因为 `continue-on-error`
  会改写 `conclusion`）
- 载荷校验失败 → 该步骤在写出 output 之前就失败

空的复用 ID 会执行完整的原生构建矩阵。重新构建现在把 Node 和 prebuildify
目标固定为 22.22.3，存在锁文件时使用按包筛选、冻结的 pnpm 依赖；只有旧 ref
保留 npm install 路径。试下载的字节会被丢弃、由消费方重新下载。

发布方不信任 `prepare` 的判断：它用自己的 checkout 重算指纹、重新校验来源
运行、按 artifact ID 下载并再次校验载荷。这一校验是致命的——此时原生构建
矩阵已被跳过，所以坏产物必须让发布停止，而不是发出去。此阶段下载失败或
产物被删除也会停止发布，不会重新启动已跳过的构建矩阵。

校验检查恰好五个目标目录，每个目录只包含非空的普通 `.node` 文件且无符号
链接。这是形状校验而不是平台校验；信任由上述来源校验和摘要校验承载。

### 汇总任务的卫生

汇总任务在可能持久的工作区上合并各平台产物，而 `download-artifact` 的
`merge-multiple` 会合并进已存在的路径，因此残留的 `prebuilds/` 目录会泄漏
进它上传的产物。

现在改为通过共享的 release runner 预检来清理：预检会规范化工作区，并拒绝
经由符号链接组件解析、或落在 runner 工作区之外的路径。被它替换掉的子目录
`rm -rf` 会按主机上当时的 `packages` 解析：存在残留符号链接时，它删除了
工作区外的目录并 exit 0，随后的下载又从同一链接写入。

现有 release workflow 的清理锚点也调用同一 action，因此工作区边界检查与
Git/npm/Docker/gh 状态隔离只有一份实现。action 在 checkout 前按 workflow
SHA 把脚本下载到 runner 临时目录，不执行工作区残留的副本。Node 准备与现有
磁盘余量门禁继续独立于工作区清理。

汇总任务在 self-hosted 上使用现有的预装 Node 预检，在 hosted 上把
`setup-node` 固定为 22.22.3，两者都在载荷校验前执行。原生编译始终使用
Node 22.22.3。工作区清理本身不依赖 Node，也不增加比现有 self-hosted
预检更严格的版本门禁。

它的 release 专用 label 去掉了 `x64` 组件：承载 `ecs-qwen-release-host`
的 runner 是 ARM64，而该 label 里的架构组件不会回退到 hosted——它永远匹配
不上，任务会一直排队到超时。

### 与 release host 开关的关系

以上都不依赖 `ECS_RELEASE_HOST_RUNNER_ENABLED`。复用决策发生在 `prepare`，
它本就运行在自己的池上，消费方是现有的发布任务。开关保持未设置，这项改动
依然生效。

汇总任务和发布任务都从 opt-in release-host 标签中移除了 `x64` 组件。
开关未设置时，两者仍使用 GitHub-hosted runner。保持开关未设置：隔离构建
通道与 hosted npm 发布的边界由 #15832 处理，启用前还须确认主机隔离。

## 验证

指纹、来源、保留期和载荷行为由单元测试配合直接 witness 覆盖，包括促成
选择/消费分离的那个保留期边界。workflow 的接线——非致命查询、以 `outcome`
为判据的接受步骤、矩阵跳过、发布方重新校验、汇总任务步骤顺序以及不含架构的
label——由契约测试固定，每一条都经过注入回归确认能够失败。

分支 release dry-run 可以在不发布的情况下验证未命中路径、五种原生载荷与
发布方消费。它不能产生可信的复用候选，因为生产者必须运行在 `main`。
先由一次成功的 `main` 运行保存带指纹的产物，后续相同 key 的运行才可验证
复用。此次验证保持 release-host 开关未设置；汇总任务在 self-hosted 上的
执行不属于该次运行的证据。

## 涉及文件

`.github/scripts/audio-prebuilds.mjs`、音频与发布 workflow、它复用的共享
release runner 预检、`scripts/tests` 下的 workflow 测试，以及 workflow
大小基线。

## 待确认

label 不变而 runner 镜像更新时，指纹不会变化。N-API 稳定的是 Node ABI，
不是 glibc 或工具链链接，所以这里复用的是经过验证的二进制，而不保证重新
构建能产出逐字节一致的结果。pin 住构建容器可以消除这一缺口，不在本次范围。
