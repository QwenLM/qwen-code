# E2E：一次构建，每条 leg 各自解包

[English](e2e-build-once.md) | [简体中文](e2e-build-once.zh-CN.md)

`.github/workflows/e2e.yml` 里 `build` job 的设计说明：由一个 job 构建并打包
本次提交，十一条测试 leg 下载它的产物，而不是各自重新构建一次。

## 背景

E2E workflow 的每一条 leg —— 共享 ECS 池上的六个 Linux 分片、两个 macOS 分片、
OpenTUI 交互式 leg 以及两条 nightly 隔离 leg —— 在跑到第一个测试之前，都要在自己的
runner 上执行 `npm ci`、`npm run build` 和 `npm run bundle`。托管 VM 上这是 4–8 分钟；
在繁忙的池机器上，光是 build 这一步就要 10–17 分钟（run 33718808438：先构建 10–17
分钟，再跑 12–39 分钟测试）。于是六个池分片花在「重复构建同一个提交」上的共享机器时间
比花在测试上还多，并且在一次 21 小时的采样里，E2E 占掉了池子 slot-minutes 的 11%。
每次推送到 `main` 都会启动一次新的 run，所以这件事每天要重复很多次。

## 决策

- 一个 `build` job 负责安装（带 `QWEN_SKIP_PREPARE=1`）、构建、打包，并用
  `.github/scripts/e2e-build-pack.sh` 归档产物：主产物（`dist/`）、根 `package.json`
  的 `workspaces` 所声明的每个根目录下的 workspace `dist/`（剔除 node_modules，已匹配的
  `dist/` 不再向下递归），以及一个记录提交号的 `e2e-build.sha` 戳。当主产物缺失，或扫描
  下来一个 workspace `dist/` 都没有时，脚本会以 `::error::` 行 fail closed —— 与
  release.yml 的 Pack Build Outputs 用的是同一套「打包不足即失败」契约。归档是一个 gzip
  tarball，以 `e2e-build` artifact 上传，保留一天。
- 每条 leg 都加上 `needs: [build]`，保留自己的 `npm ci`（node_modules、原生模块，以及
  `prepare` 仍会执行的 `generate` 步骤），并把自己的 build 与 bundle 步骤换成一次下载加
  `.github/scripts/e2e-build-unpack.sh`。该脚本在解包之前就会拒绝戳了不同提交号的归档，
  或其中没有 `dist/cli.js` 的归档；解包之后还会复查主产物是否就位。
- docker sandbox 镜像不变：它在 Docker 内部、按每机锁从 checkout 构建，因此不属于归档内容。
- build job 带着与 leg 相同的 fork 门禁，所以 build 被跳过时，leg 也因同一个原因被跳过，
  而不是因为缺 artifact 而失败。

## 为什么 build 离开了托管 runner

build 原先被钉在托管 runner 上，因为它是平台无关的 JavaScript —— 平台相关的部分是原生
模块，由各条 leg 自己的 `npm ci` 安装。托管 VM 构建它约四分钟，且不与池子争抢资源，ECS
leg 随后只需付出一次下载的成本。当时的预期是：把构建放到池上，会让整个 run 都要等的那个
job 排到同一条让 leg 变慢的队列里。

这个前提在 2026-10-28 反转了。本仓库的托管 ubuntu 分配在一天之内持续恶化：从等待 47 分钟
（run 创建于 02:19 UTC，build 03:06 启动），到 2 小时 16 分钟（build 04:56 启动），再到
2 小时 52 分钟（run 创建于 05:26 UTC，build 08:18 启动）；与此同时，自建池 —— 几百台
runner，大多空闲 —— 一直没被用上。每条 leg 都要等 `build`，而 `build` 待在托管 ubuntu 上，
于是每次推送 `main` 都会积压一个排队中的 run，堆积无法消化。现在 build 与各条 leg 共用
pool-first 路由（优先 ecs-qwen 池，仅在池被禁用时回落到托管 ubuntu），并且带上池的
self-hosted 契约：checkout 之前的 workspace 属主修复、预装 Node 的 preflight、常驻 npm
缓存，以及磁盘水位门禁。在该改动的一次探测 run（40935790797）里，build 在创建后 4 秒就
被调度到池上，6 分 02 秒完成。

OpenTUI 交互式 leg 仍然钉在托管 runner 上，所以一次 run 仍可能因为等它而结束在托管排队上；
重新路由它是另一个独立决策。

## 本机实测

- 构建 `a8248eaed3` 得到的归档 gzip 压缩后 85 MB、14,408 个文件；打包耗时 16 秒。
- 同一提交上的一个干净 worktree，用 `QWEN_SKIP_PREPARE=1` 安装（各处都没有 `dist/`），
  可以解开该归档并从还原出来的产物跑通 no-AK 集成门禁。戳与 `GITHUB_SHA` 不一致的归档，
  解包步骤会直接拒绝，且不解出任何内容。
- `.github/scripts/e2e-build.test.mjs` 覆盖打包与解包契约（workspace dist/ 选取、
  node_modules 剔除、权限位保留、戳校验），并在 CI 的 helper-test 步骤中运行。

## 已考虑的替代方案

- **直接用 `upload-artifact` 上传目录。** artifact 存储不保留文件权限位，而且每次 run 要
  上传 1.4 万个对象；tarball 是一个对象，并且保留权限位。
- **在池上做同一主机共享的构建缓存。** 早前已被否决（#10129），理由是它会在同一台机器上的并发
  job 之间引入共享可变状态。
- **只接六个 Linux 分片。** macOS、OpenTUI 和 nightly leg 构建的是同一份 JavaScript，因此
  它们消费同一个归档；把它们排除在外只会让每次 run 多跑三次构建，信号上没有任何收益。

## 后续工作

- 如果池上的下载耗时确实成为问题，把归档裁剪到测试真正会解析的那些 workspace `dist/` 目录树。
- 等队列能力开启后，取消 `main` 上被取代的 run，让一批集中合并只构建并测试最新的那个提交。
