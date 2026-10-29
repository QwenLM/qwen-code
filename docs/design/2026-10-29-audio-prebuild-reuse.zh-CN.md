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
保留 npm install 路径。hosted 与 ECS 上的 Linux 在 `node:22.22.3-bookworm` 容器中执行
同样的冻结安装，保留已有的 glibc 基线。试下载的字节会被丢弃、由消费方
重新下载。

ECS 构建任务与 hosted 发布任务分别使用自己的 checkout 重算指纹、重新校验
来源运行、按 artifact ID 下载并再次校验载荷。这一校验是致命的——此时原生构建
矩阵已被跳过，所以坏产物必须让发布停止，而不是发出去。此阶段下载失败或
产物被删除也会停止发布，不会重新启动已跳过的构建矩阵。

校验检查恰好五个目标目录，每个目录只包含非空的普通 `.node` 文件且无符号
链接。这是形状校验而不是平台校验；信任由上述来源校验和摘要校验承载。

### 汇总任务的卫生

汇总任务在可能持久的工作区上合并各平台产物，而 `download-artifact` 的
`merge-multiple` 会合并进已存在的路径，因此残留的 `prebuilds/` 目录会泄漏
进它上传的产物。

汇总任务使用 main 已有的共享 release runner 预检：规范化并清空工作区，
拒绝经由符号链接组件解析、或落在 runner 工作区之外的路径。本次保留该
共享 action 及其清理实现。

action 在 checkout 前按 workflow SHA 把清理与磁盘余量脚本下载到 runner
临时目录。它隔离 Git/npm/Docker/gh 状态，提供任务私有 npm 安装目录，
断言 Node 22 并检查磁盘余量。清理脚本本身不依赖 Node。

汇总任务在 self-hosted 上使用现有的预装 Node 预检，在 hosted 上把
`setup-node` 固定为 22.22.3，两者都在载荷校验前执行。原生编译始终使用
Node 22.22.3。汇总任务保留不含架构的 label；Linux 构建任务保留与目标
匹配的 x64 或 arm64 release runner label。

### 与 release host 开关的关系

`ECS_RELEASE_HOST_RUNNER_ENABLED` 启用或未设置时，音频复用都能工作。
决策发生在 `prepare`。开关未设置时，现有 hosted 发布任务构建并消费音频
产物；启用后，ECS 构建任务先消费音频产物，再把发布输出交给 hosted 发布
任务，后者也会校验音频来源和载荷。两种情况下 npm 发布都保持 hosted，
保留 #15832 已合入的构建与发布拆分。

本改动不改变 runner 路由，也不启用开关。命中缓存时跳过原生构建矩阵，
未命中时沿用现有 hosted/ECS 路由。

## 验证

指纹、来源、保留期和载荷行为由单元测试配合直接 witness 覆盖，包括促成
选择/消费分离的那个保留期边界。workflow 的接线——非致命查询、以 `outcome`
为判据的接受步骤、矩阵跳过、发布方重新校验、汇总任务步骤顺序以及不含架构的
label——由契约测试固定，每一条都经过注入回归确认能够失败。

分支 release dry-run 可以在不发布的情况下验证未命中路径、五种原生载荷与
发布方消费。它不能产生可信的复用候选，因为生产者必须运行在 `main`。
先由一次成功的 `main` 运行保存带指纹的产物，后续相同 key 的运行才可验证
复用。每次 dry-run 都应记录开关状态及各任务实际使用的 runner。hosted
运行不能证明 ECS 路径，未命中运行也不能证明复用路径。

## 涉及文件

`.github/scripts/audio-prebuilds.mjs`、音频与发布 workflow、它复用的共享
release runner 预检、`scripts/tests` 下的 workflow 测试，以及 workflow
大小基线。

## 待确认

label 不变而 runner 镜像更新时，指纹不会变化。N-API 稳定的是 Node ABI，
不是 glibc 或工具链链接，所以这里复用的是经过验证的二进制，而不保证重新
构建能产出逐字节一致的结果。hosted 与 ECS 上的 Linux 使用带版本的 Bookworm 容器 tag，
并非不可变镜像摘要；macOS 和 Windows 的 hosted 镜像也会继续更新。完全固定这些环境不在本次范围。
