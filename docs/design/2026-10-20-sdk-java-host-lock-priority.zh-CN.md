# SDK Java 宿主机锁：优先服务 fast tier

[English](2026-10-20-sdk-java-host-lock-priority.md) | [简体中文](2026-10-20-sdk-java-host-lock-priority.zh-CN.md)

## 问题

`.github/workflows/sdk-java.yml` 让所有 self-hosted Maven 步骤串行在同一把锁上：
`~/.cache/qwen-code-ci/sdk-java-tests.lock`，通过 `flock --wait` 获取。
`flock(2)` 不保证唤醒顺序，因此在持续到达的情况下，某个等待者可能每次都输掉
唤醒竞争，直到耗尽预算。fast tier 的 pull request job 是最小的参与者：
2026-10-20 的 run 39431579628 中，`SDK Java (fast) / ubuntu-latest / Java 21`
在 full-tier 的持锁任务后面等满了 5400 秒，Maven 还没启动就失败了，因此没有
任何测试结果（#14962）。把预算从 2400 → 3600 → 5400 秒只是把悬崖往后挪。

## 目标与非目标

- 目标：fast tier 的 PR job 最多只等当前正在运行的那一次持锁，而不是排在
  一串 full-tier 持锁任务后面。
- 目标：保持释放语义（锁留在 step 的 fd 9 上，在 step 边界自动释放）、
  固定的 `lock not acquired within` 错误签名，以及 5400 秒预算。
- 非目标：把 lane 移出 ECS 池。fast tier 仍留在 self-hosted；托管 runner
  方向已撤回（#14935）。
- 非目标：降低总占用。按 suite 拆分锁、限制每台主机的注册数、增加主机都是
  正交的后续工作。

## 设计

新增一个被 source 的辅助脚本 `.github/scripts/sdk-java-lock.sh`，替换两个
self-hosted 取锁点里的内联 `exec 9>lock; flock --wait` 代码块。

- 每个获取者从受计数器锁目录保护的计数器里取一个序号，然后在
  `<lock>.queue/` 下写入 `rank.sequence.pid.ticket`。
- 只有最老的活动票据会尝试取锁。队首以 5 秒切片阻塞在内核唤醒竞争中，这样
  预算仍然精确，并且与来自旧分支、仍在使用内联 `flock --wait` 的等待者
  处于同等竞争地位。
- `fast` 票据排在 `normal` 票据之前。test job 传入自己的 `TIER`，因此
  `pull_request` 运行进入 fast 类别，approval 和 main 的 full-tier 工作
  保持 normal。
- 等待超过 `SDK_JAVA_LOCK_PROMOTE_AFTER`（默认 1200 秒）的 normal 票据会被
  改名进 fast 类别，因此持续的 PR 流量无法饿死 full tier。
- 票据携带持有者的 PID。下一次队首检查会回收 owner 已死亡且超过十秒未更新
  的票据；活着的等待者每轮循环都会 touch 自己的票据。
- 成功后 trap 会删除票据，锁继续以 fd 9 持有。超时时辅助脚本删除自己的
  票据，打印固定的
  `sdk-java host lock not acquired within N minutes as queue ticket S`
  行，并返回 1。

## 验证计划

- `scripts/tests/sdk-java-lock.test.js` 钉住 FIFO 顺序、fast 先于更老的
  normal 票据、aging 提升、过期 owner 回收，以及超时签名与票据清理。
  `flock` 通过 `PATH` stub 注入；shell 以和 workflow step 相同的
  `-eo pipefail` 运行。
- `scripts/tests/sdk-java-workflow.test.js` 钉住两个 self-hosted 取锁点
  source 该辅助脚本、5400 秒预算，以及 fast tier 的 `TIER` 参数。
- workflow 大小 ratchet 覆盖 workflow 文件；辅助脚本把内联代码块移出了
  workflow。

## 验收标准

- 两个 self-hosted 取锁点都 source 辅助脚本并以 5400 秒取锁。
- test job 传入 `TIER`；MariaDB lane 使用默认的 normal 类别。
- 上述聚焦 Vitest 文件通过。

## 风险与待决问题

- 混合舰队：旧的内联等待者仍会和队首竞争，因此顺序只在使用了辅助脚本的
  运行之间得到保证。合并后新的运行都会使用它，剩余问题是 #14743 已有的
  条件。
- 持续的 fast 票据流最多让 normal 工作多等一个提升间隔；如果这个间隔太长，
  aging 边界就是调节旋钮。
- 如果死亡等待者的 PID 被一个长生命周期进程复用，它的票据会一直保留到该
  进程退出。这与今天的最坏情况相同。
