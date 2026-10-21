# SDK Java 宿主机锁：优先服务 fast tier

[English](2026-10-20-sdk-java-host-lock-priority.md) | [简体中文](2026-10-20-sdk-java-host-lock-priority.zh-CN.md)

## 问题

`.github/workflows/sdk-java.yml` 让所有 self-hosted Maven 步骤串行在同一台
主机上的同一个文件上：`~/.cache/qwen-code-ci/sdk-java-tests.lock`。为 #14743
加入的 FIFO 票据队列（见[队列设计](2026-10-20-sdk-java-fair-lock-queue.zh-CN.md)）
把每个等待者的等待限制在它的排队位置上，但 fast tier 的 pull request job
仍然从队尾进入：2026-10-20 的 run 39431579628 中，`SDK Java (fast) /
ubuntu-latest / Java 21` 在 full-tier 持锁后面等满了 5400 秒，Maven 还没
启动就失败了，因此没有任何测试结果（#14962）。

## 目标与非目标

- 目标：fast tier 的 PR 票据先于所有等待中的 normal 票据被服务，因此它
  最多只等当前正在运行的那一次持锁，加上已经阻塞在内核里的那个 normal
  队首，而不是排在后面的整条 full-tier 队列。
- 目标：保持 FIFO 队列的释放语义（锁留在 step 的 fd 9 上，在 step 边界
  自动释放）、固定的 `lock not acquired within` 错误签名，以及 5400 秒
  预算。
- 非目标：抢占已经阻塞在 `flock(2)` 里的 normal 票据。内核唤醒顺序不由
  我们控制，因此 fast 的上界是两次持锁而不是一次。
- 非目标：按 tier 拆分锁。FIFO 设计已把它记录为替代方案；那会让同一台
  主机上允许两个 Maven 并发。

## 设计

fast 类别叠加在 `.github/scripts/sdk-java-lock.sh` 的 FIFO 辅助脚本上；
队列、计数器、队首探测、释放与回收机制沿用 FIFO 设计。

- 票据命名为 `rank-sequence-pid`。`fast` 为 rank 0，`normal` 为 rank 1；
  队首是最小的活动票据名，因此所有 fast 票据都排在所有尚未提升的 normal 票据之前，
  无论先后。test job 传入自己的 `TIER`，因此 `pull_request` 运行进入 fast
  类别，approval 和 main 的 full-tier 工作保持 normal。
- 等待超过 `SDK_JAVA_LOCK_PROMOTE_AFTER`（默认 1200 秒）的 normal 票据会
  被改名进 fast 类别。它保留自己的序号，因此仍排在它之后到达的 fast 票据
  之前；持续的 PR 流量无法饿死 full tier。
- 队首用一次 `flock --wait` 阻塞到剩余预算，与 FIFO 设计一致。因此当
  normal 票据已经阻塞在内核里时，后到的 fast 票据无法取代它的内核等待
  位置；它会在当前持锁和该队首的持锁之后被服务。
- 票据携带持有者的 PID 与 `/proc/<pid>/stat` 的启动时间（第 22 字段）。
  下一次队首检查会回收 owner 已死亡且超过十秒 mtime 宽限的票据，也会回收
  PID 仍活着但启动时间不匹配的票据 —— 即 PID 被复用。没有记录启动时间的
  票据（升级前的文件，或没有 `/proc` 的主机）回退到 FIFO 设计的 1800 秒
  mtime 兜底。
- 成功后删除票据，锁继续以 fd 9 持有。超时时辅助脚本删除自己的票据，
  打印固定的
  `sdk-java host lock not acquired within N minutes as queue ticket S`
  行，并返回 1。

## 验证计划

- `scripts/tests/sdk-java-lock.test.js` 钉住 FIFO 顺序、fast 先于更老的
  normal 票据、aging 提升、死 owner 回收（含 PID 复用）、票据发布的启动
  时间、1800 秒兜底仅适用于没有启动时间的票据、超时签名与票据清理，以及
  队首阻塞诊断。`flock` 通过 `PATH` stub 注入；shell 以和 workflow step
  相同的 `-eo pipefail` 运行。
- `scripts/tests/sdk-java-workflow.test.js` 钉住两个 self-hosted 取锁点
  source 该辅助脚本、5400 秒预算、resumed release tag 的裸锁回退，以及
  fast tier 的 `TIER` 参数。
- workflow 大小 ratchet 覆盖 workflow 文件；辅助脚本把内联代码块移出了
  workflow。

## 验收标准

- 两个 self-hosted 取锁点都 source 辅助脚本并以 5400 秒取锁。
- test job 传入 `TIER`；MariaDB lane 使用默认的 normal 类别。
- 上述聚焦 Vitest 文件通过。

## 风险与待决问题

- fast 优先是两次持锁而不是一次：已经阻塞在内核里的 normal 队首会先于
  新到的 fast 票据赢得释放。实测上界约为 2 × 925 秒，远在 5400 秒预算
  之内。
- 混合舰队：旧的内联等待者不在队列里，fast 票据仍可能输给它们。该上界
  只在使用了辅助脚本的运行之间成立；舰队统一后，剩余问题就是 #14743
  已有的条件。
- 持续的 fast 票据流最多让 normal 工作多等一个提升间隔；如果这个间隔
  太长，aging 边界就是调节旋钮。
- 被 SIGKILL 的等待者会留下票据，直到下一次队首检查回收：owner 已死或
  PID 被复用时在十秒宽限内回收；没有记录启动时间的票据才走 1800 秒兜底。
